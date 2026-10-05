import { NextResponse } from 'next/server'
import { isAddress, isHex, type Address, type Hex } from 'viem'
import { createAdminClient } from '@/lib/supabase/admin'
import { apiError } from '@/lib/arcade-types'
import { getSession, transitionSession } from '@/lib/session-store'
import { verifyScoreRecorded, waitForConfirmation } from '@/lib/server-blockchain'
import { consumeLimit, rateLimitResponse, requestIp } from '@/lib/rate-limit'
import { getServerEnv } from '@/lib/server-env'
import { arenaByType } from '@/lib/arcade-arenas'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const ipLimit = await consumeLimit('confirm_score_ip', requestIp(request))
    if (!ipLimit.allowed) return rateLimitResponse(requestId, ipLimit.retryAfter)
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return apiError('INVALID_JSON', 'Content-Type debe ser application/json.', 415, requestId)
    const body = await request.json() as Record<string, unknown>
    const sessionId = body.sessionId
    const wallet = body.wallet
    const txHash = body.txHash
    if (typeof sessionId !== 'string' || sessionId.length < 10 || typeof wallet !== 'string' || !isAddress(wallet) || typeof txHash !== 'string' || !isHex(txHash, { strict: true }) || txHash.length !== 66) {
      return apiError('INVALID_SCORE', 'The score transaction details are invalid.', 422, requestId)
    }
    const sessionLimit = await consumeLimit('confirm_score_session', sessionId)
    if (!sessionLimit.allowed) return rateLimitResponse(requestId, sessionLimit.retryAfter)
    const session = await getSession(sessionId)
    if (!session) return apiError('SESSION_NOT_FOUND', 'The session does not exist.', 404, requestId)
    if (session.wallet.toLowerCase() !== wallet.toLowerCase()) return apiError('INVALID_SCORE', 'The wallet does not match the session.', 403, requestId)
    const db = createAdminClient()
    const { chainId } = getServerEnv()
    const pending = await db.from('arcade_scores').select('id,score,status,tx_hash').eq('session_id', sessionId).maybeSingle()
    if (pending.error) throw pending.error
    if (!pending.data) return apiError('SESSION_CONFLICT', 'The score submission does not exist.', 409, requestId)
    if (pending.data.status === 'recorded') return NextResponse.json({ status: 'confirmed', txHash: pending.data.tx_hash ?? txHash, requestId })
    if (pending.data.status === 'failed') return apiError('CHAIN_UNAVAILABLE', 'The score transaction failed.', 503, requestId)
    const existingHash = pending.data.tx_hash as Hex | null
    if (existingHash && existingHash.toLowerCase() !== txHash.toLowerCase()) return apiError('SESSION_CONFLICT', 'A different transaction is already pending for this session.', 409, requestId)
    const saved = await db.from('arcade_scores').update({ tx_hash: txHash, chain_id: chainId, submitted_at: new Date().toISOString() }).eq('id', pending.data.id).eq('status', 'submitting').is('tx_hash', null).select('id').maybeSingle()
    if (saved.error) throw saved.error
    const receipt = await waitForConfirmation(txHash as Hex, requestId)
    if (receipt.status !== 'success') {
      await db.from('arcade_scores').update({ status: 'failed', failed_at: new Date().toISOString(), error_code: 'CHAIN_TX_FAILED' }).eq('id', pending.data.id).eq('status', 'submitting')
      await transitionSession(sessionId, 'submitting', 'failed', { error_code: 'CHAIN_TX_FAILED' })
      return apiError('CHAIN_UNAVAILABLE', 'The score transaction failed.', 503, requestId)
    }
    // FINDING (critical, esta migracion): el `arena` iba HARDCODEADO a 0, igual que en
    // app/api/play/finish. Esta es la TERCERA copia del mismo defecto y la mas facil de no ver,
    // porque `confirm` no es el camino normal: solo entra cuando el cliente ya envio su tx y la
    // server-side no llego a confirmar la suya. Es decir, el momento en que la sesion esta a
    // medias y hace falta reconciliar.
    //
    // Con `arena: 0` el log de `ScoreRecorded` se buscaba con el id de `human`. Para una sesion de
    // `medium` o `hard` el evento existe en la cadena con OTRO arena, asi que la comprobacion
    // fallaba y caia al catch: `SCORE_RECORDED_EVENT_MISSING` -> 422 'The transaction does not
    // contain the expected score.' Al cliente le dicen que su score es invalido cuando lo que pasa
    // es que el servidor no lo encontro por mirar en la arena equivocada. Y si `verifyScoreRecorded`
    // llegara a ser permisivo con el arena, confirmaria un score contra un modo que no es el suyo.
    //
    // El id sale de la SESION, que es lo unico que el cliente no controla. `arenaByType` tambien
    // hace de guardia: si la sesion apunta a una arena que el registro ya no conoce, se rechaza
    // en vez de verificar con un id inventado. Es el mismo guardia que hace app/api/play/finish.
    const arenaConfig = arenaByType(session.arena)
    if (!arenaConfig) return apiError('INVALID_SCORE', 'The session refers to an unknown arena.', 422, requestId)
    verifyScoreRecorded(receipt, { player: session.wallet as Address, arena: arenaConfig.id, epoch: session.epoch, score: pending.data.score, sessionId: session.sessionId as Hex })
    // tx_hash is set again here rather than assumed: the arcade_scores_recorded_requires_tx CHECK
    // rejects a transition to 'recorded' without on-chain proof, and this route accepts the hash from
    // the client request, so it must be persisted on the row that reaches 'recorded'.
    const confirmed = await db.from('arcade_scores').update({ status: 'recorded', tx_hash: txHash, confirmed_at: new Date().toISOString() }).eq('id', pending.data.id).eq('status', 'submitting').select('id').maybeSingle()
    if (confirmed.error) throw confirmed.error
    await transitionSession(sessionId, 'submitting', 'recorded', { score: pending.data.score, score_tx_hash: txHash })
    return NextResponse.json({ status: 'confirmed', txHash, requestId })
  } catch (error) {
    if (error instanceof Error && (error.message === 'SCORE_RECORDED_EVENT_MISSING' || error.message === 'SCORE_RECORDED_MISMATCH')) return apiError('INVALID_SCORE', 'The transaction does not contain the expected score.', 422, requestId)
    return apiError('CHAIN_UNAVAILABLE', 'The score transaction is still awaiting confirmation.', 503, requestId)
  }
}
