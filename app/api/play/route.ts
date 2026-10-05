import { NextResponse } from 'next/server'
import { isHex, type Hex } from 'viem'
import { createAdminClient } from '@/lib/supabase/admin'
import { findPaymentByTxHash, reconcilePaymentToSession } from '@/lib/session-store'
import { apiError } from '@/lib/arcade-types'
import { arenaByType, maxScoreFor, parseArenaParam } from '@/lib/arcade-arenas'
import { ContractMismatchError, readArena, verifyPayment, verifyVaultCompatibility } from '@/lib/server-blockchain'
import { ARCADE_ENTRY_CUTOFF_SECONDS } from '@/lib/arcade-config'
import { getServerEnv } from '@/lib/server-env'
import { consumeLimit, rateLimitResponse, requestIp } from '@/lib/rate-limit'
import { logOperationalError } from '@/lib/server-log'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  let ipLimit
  try { ipLimit = await consumeLimit('play_ip', requestIp(request)) } catch (error) {
    logOperationalError('play.rate_limit.ip', requestId, error)
    return apiError('CHAIN_UNAVAILABLE', 'Request controls are unavailable.', 503, requestId)
  }
  if (!ipLimit.allowed) return rateLimitResponse(requestId, ipLimit.retryAfter)

  // El modo se resuelve ANTES de nada, incluso antes del 402. El 402 es lo que el wallet lee
  // para saber cuanto enviar, asi que tiene que anunciar el precio del modo pedido: si aqui se
  // anunciara siempre el de human, un cliente que entra a medium recibiria un importe y luego la
  // verificacion rechazaria el pago por importe incorrecto, sin explicacion.
  //
  // Sin `?arena=`, se cae a human. Es el unico default permitido y es explicito en la respuesta,
  // porque las llamadas existentes no lo envian.
  const requestedArena = new URL(request.url).searchParams.get('arena')
  const arenaType = parseArenaParam(requestedArena) ?? 'human'
  const arenaConfig = arenaByType(arenaType)
  if (!arenaConfig || !arenaConfig.playable) return apiError('INVALID_JSON', 'The requested arena is not available.', 400, requestId)
  const entryFee = arenaConfig.entryFeeWei

  const payment = request.headers.get('x-payment')
  if (!payment) return NextResponse.json({ status: 402, payTo: getServerEnv().vault, amount: entryFee.toString(), amountHuman: `${formatSvp(entryFee)} SVP`, arena: arenaType, arenaId: arenaConfig.id, network: 'SVP Chain Testnet', chainId: getServerEnv().chainId, requestId }, { status: 402 })
  if (!isHex(payment, { strict: true }) || payment.length !== 66) return apiError('INVALID_PAYMENT', 'The payment identifier is invalid.', 422, requestId)
  let txLimit
  try { txLimit = await consumeLimit('play_tx', payment.toLowerCase()) } catch (error) {
    logOperationalError('play.rate_limit.transaction', requestId, error)
    return apiError('CHAIN_UNAVAILABLE', 'Request controls are unavailable.', 503, requestId)
  }
  if (!txLimit.allowed) return rateLimitResponse(requestId, txLimit.retryAfter)

  let existingPayment
  try { existingPayment = await findPaymentByTxHash(payment) } catch (error) {
    logOperationalError('play.payment.reconcile.lookup', requestId, error)
    return apiError('PAYMENT_PERSISTENCE_FAILED', 'We could not look up the recorded payment.', 503, requestId)
  }
  let compatibility
  try { compatibility = await verifyVaultCompatibility(arenaConfig.id, requestId) } catch (error) {
    logOperationalError('play.contract.compatibility', requestId, error)
    if (error instanceof ContractMismatchError) return apiError('CONTRACT_MISMATCH', error.message, 503, requestId)
    return apiError('CHAIN_UNAVAILABLE', 'We could not verify the contract deployment.', 503, requestId)
  }
  let paymentData: Awaited<ReturnType<typeof verifyPayment>>
  if (existingPayment?.status === 'verified') {
    // Un pago ya verificado se reutiliza tal cual. Su modo viene de la fila del pago, no del
    // `?arena=` de esta peticion: si se aceptara el parametro, reenviar el mismo tx contra otra
    // arena devolveria la sesion del modo original y el cliente creeria estar jugando otro.
    paymentData = { txHash: existingPayment.tx_hash as Hex, wallet: existingPayment.wallet as `0x${string}`, chainId: Number(existingPayment.chain_id), amountWei: BigInt(String(existingPayment.amount_wei)), epoch: BigInt(String(existingPayment.epoch)), arena: arenaConfig.id }
  } else {
    try {
      paymentData = await verifyPayment(payment as Hex, arenaConfig.id, requestId)
    } catch (error) {
      logOperationalError('play.payment.verify', requestId, error)
      if (error instanceof ContractMismatchError) return apiError('CONTRACT_MISMATCH', error.message, 503, requestId)
      return apiError('INVALID_PAYMENT', 'We could not verify this payment.', 422, requestId)
    }
  }
  try {
    const walletLimit = await consumeLimit('play_wallet', paymentData.wallet.toLowerCase())
    if (!walletLimit.allowed) return rateLimitResponse(requestId, walletLimit.retryAfter)
  } catch (error) {
    logOperationalError('play.rate_limit.wallet', requestId, error)
    return apiError('CHAIN_UNAVAILABLE', 'Request controls are unavailable.', 503, requestId)
  }

  const db = createAdminClient()
  if (existingPayment && existingPayment.status !== 'verified') return apiError('PAYMENT_REPLAY', 'This payment was already used for a game.', 409, requestId)
  if (!existingPayment) {
    const inserted = await db.from('arcade_payments').insert({ tx_hash: paymentData.txHash, wallet: paymentData.wallet, chain_id: paymentData.chainId, amount_wei: paymentData.amountWei.toString(), epoch: paymentData.epoch.toString(), arena_type: arenaType, status: 'verified' }).select('id').maybeSingle()
    if (inserted.error?.code === '23505') {
      const racedPayment = await findPaymentByTxHash(paymentData.txHash)
      if (!racedPayment || racedPayment.status !== 'verified') return apiError('PAYMENT_REPLAY', 'This payment was already used for a game.', 409, requestId)
      logOperationalError('play.payment.reconcile.race_recovered', requestId, new Error('payment insert race recovered'))
    } else if (inserted.error || !inserted.data) {
      logOperationalError('play.payment.persistence', requestId, inserted.error ?? new Error('missing payment row'))
      return apiError('PAYMENT_PERSISTENCE_FAILED', 'The payment was verified, but could not be saved.', 503, requestId)
    }
  }

  const arena = await readArena(arenaConfig.id, requestId)
  const secondsRemaining = arena.secondsLeft
  const contractEpochDuration = compatibility?.epochDuration ?? arena.epochDuration
  if (!arena.active || arena.paused || contractEpochDuration !== arena.epochDuration || paymentData.epoch !== arena.currentEpoch || secondsRemaining < BigInt(ARCADE_ENTRY_CUTOFF_SECONDS)) {
    console.info(JSON.stringify({ event: 'session_creation_failed', requestId, arena: arenaType, reason: 'insufficient_game_window', paymentEpoch: paymentData.epoch.toString(), currentEpoch: arena.currentEpoch.toString(), secondsRemaining: secondsRemaining.toString() }))
    return apiError('EPOCH_CLOSED', 'There is not enough time remaining in this epoch to start a game.', 409, requestId)
  }
  try {
    const session = await reconcilePaymentToSession({ txHash: paymentData.txHash, epoch: paymentData.epoch })
    // La sesion se crea con el modo del PAGO. Si no coincide con el pedido, el pago pertenece a
    // otra partida y no se puede reutilizar: decirlo aqui evita que el cliente entre en una
    // sesion de human creyendo que esta jugando en hard.
    if (session.arena !== arenaType) {
      console.info(JSON.stringify({ event: 'session_creation_failed', requestId, reason: 'arena_mismatch', requested: arenaType, paymentArena: session.arena }))
      return apiError('CONTRACT_MISMATCH', 'This payment was made for a different arena.', 409, requestId)
    }
    return NextResponse.json({ sessionId: session.sessionId, status: 'ready', arena: arenaType, arenaId: arenaConfig.id, entryFee: entryFee.toString(), gameplay: arenaConfig.gameplay, maxScore: maxScoreFor(arenaType), expiresAt: session.expiresAt, expiresIn: Math.max(0, Math.ceil((Date.parse(session.expiresAt) - Date.now()) / 1000)), gameSeed: session.gameSeed, txHash: paymentData.txHash, requestId })
  } catch (error) {
    logOperationalError('play.session.create', requestId, error)
    return apiError('SESSION_CREATE_FAILED', 'The payment was verified, but we could not create the session.', 503, requestId)
  }
}

/** Formatea wei a SVP sin perder decimales. Solo para texto que ve una persona. */
function formatSvp(wei: bigint): string {
  const whole = wei / BigInt('1000000000000000000')
  const frac = wei % BigInt('1000000000000000000')
  if (frac === BigInt(0)) return whole.toString()
  return `${whole.toString()}.${frac.toString().padStart(18, '0').replace(/0+$/, '')}`
}
