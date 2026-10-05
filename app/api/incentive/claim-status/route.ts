import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { createAdminClient } from '@/lib/supabase/admin'
import { consumeLimit, rateLimitResponse, requestIp } from '@/lib/rate-limit'
import { requireWalletSession } from '@/lib/wallet-auth'
import { logOperationalError } from '@/lib/server-log'
import { withRpcRead } from '@/lib/rpc-manager'
import { VYNAR_REWARDS_V3_ADDRESS } from '@/lib/vynar-config'
import { vynarRewardsV3Abi } from '@/lib/vynar-rewards-v3-abi'
import { ARENA_IDS, parseArenaParam } from '@/lib/arcade-arenas'
import { reconcileVyrClaim } from '@/lib/vyr-reconciliation'

function valid(input: unknown): input is string { return typeof input === 'string' && /^\d+$/.test(input) && BigInt(input) > BigInt(0) && BigInt(input) <= BigInt(10000000) }

export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  // FINDING (medium, remediated): neither verb on this route had any rate limiting.
  try {
    const limit = await consumeLimit('incentive_claim_ip', requestIp(request))
    if (!limit.allowed) return rateLimitResponse(requestId, limit.retryAfter)
  } catch (error) {
    logOperationalError('incentive.claim_status.rate_limit', requestId, error)
    return NextResponse.json({ error: 'RATE_LIMIT_UNAVAILABLE', requestId }, { status: 503 })
  }
  const { searchParams } = new URL(request.url)
  const epoch = searchParams.get('epoch')
  // El modo se resuelve aqui y se usa en las CUATRO lecturas de abajo (la fila de vyr_claims, las
  // dos de getEpochInfo/getPercentages y la de claimed). Antes todas iban en 'human' / 0: con tres
  // modos, preguntar por el premio de medium devolvia el de human, o ningun ClaimStatus.
  const arenaType = parseArenaParam(searchParams.get('arena')) ?? 'human'
  const arenaId = ARENA_IDS[arenaType]
  // FINDING (critical, remediated): `?wallet=` used to be self-asserted and read through the
  // service-role client, so anyone could read any address's claim state.
  const session = requireWalletSession(request, searchParams.get('wallet'))
  if ('error' in session) return session.error
  if (!valid(epoch)) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 })
  const normalized = session.wallet
  const db = createAdminClient()
  // vyr_claims_wei casts numeric(78,0) points/amount to text so PostgREST returns JSON strings
  // instead of silently rounding wei-scale values above 2^53.
  const { data, error } = await db.from('vyr_claims_wei').select('epoch,arena_type,wallet,points,amount,status,tx_hash,submitted_at,confirmed_at,failed_at,error_code').eq('epoch', epoch).eq('arena_type', arenaType).eq('wallet', normalized).maybeSingle()
  if (error) return NextResponse.json({ error: 'CLAIM_STATUS_UNAVAILABLE' }, { status: 503 })
  const distributorAddress = VYNAR_REWARDS_V3_ADDRESS
  if (!distributorAddress) return NextResponse.json({ error: 'VYR_REWARDS_NOT_CONFIGURED' }, { status: 503 })
  const [info, percentages, claimed] = await Promise.all([
    withRpcRead('vyr.claim.epoch', requestId, (client) => client.readContract({ address: distributorAddress, abi: vynarRewardsV3Abi, functionName: 'getEpochInfo', args: [arenaId, BigInt(epoch)] })),
    withRpcRead('vyr.claim.percentages', requestId, (client) => client.readContract({ address: distributorAddress, abi: vynarRewardsV3Abi, functionName: 'getPercentages', args: [arenaId, BigInt(epoch)] })),
    withRpcRead('vyr.claimed', requestId, (client) => client.readContract({ address: distributorAddress, abi: vynarRewardsV3Abi, functionName: 'claimed', args: [arenaId, BigInt(epoch), normalized as `0x${string}`] })),
  ])
  const rank = info[2].findIndex((winner) => winner.toLowerCase() === normalized)
  const amount = rank >= 0 && rank < percentages.length ? (info[0] * percentages[rank]) / BigInt(10000) : BigInt(0)
  if (claimed && data) data.status = 'confirmed'
  return NextResponse.json({ claim: rank >= 0 || data ? { ...(data ?? {}), epoch, arena: arenaId, arenaType, wallet: normalized, rank: rank + 1, amount: amount.toString(), percentage: rank >= 0 ? percentages[rank].toString() : '0', claimed, status: claimed ? 'confirmed' : data?.status ?? 'available' } : null }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } })
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const limit = await consumeLimit('incentive_claim_ip', requestIp(request))
    if (!limit.allowed) return rateLimitResponse(requestId, limit.retryAfter)
  } catch (error) {
    logOperationalError('incentive.claim_status.rate_limit', requestId, error)
    return NextResponse.json({ error: 'RATE_LIMIT_UNAVAILABLE', requestId }, { status: 503 })
  }
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 }) }
  const epoch = body.epoch
  const txHash = typeof body.txHash === 'string' && /^0x[a-fA-F0-9]{64}$/.test(body.txHash) ? body.txHash : null
  const status = body.status === 'pending' || body.status === 'failed' ? body.status : null
  if (typeof body.wallet !== 'string' || !isAddress(body.wallet)) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 })
  const arenaType = parseArenaParam(typeof body.arena === 'string' ? body.arena : null) ?? 'human'
  const arenaId = ARENA_IDS[arenaType]
  // FINDING (critical, remediated): this is a WRITE behind a self-asserted wallet parameter, read
  // through the service-role client. Signing in is now mandatory.
  const session = requireWalletSession(request, body.wallet)
  if ('error' in session) return session.error
  if (!valid(epoch) || !status || !txHash) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 })
  const normalized = session.wallet
  const db = createAdminClient()
  const existing = await db.from('vyr_claims').select('points,amount,status,tx_hash').eq('epoch', epoch).eq('arena_type', arenaType).eq('wallet', normalized).maybeSingle()
  if (existing.error) return NextResponse.json({ error: 'CLAIM_STATUS_UNAVAILABLE' }, { status: 503 })
  if (existing.data?.status === 'confirmed') return NextResponse.json({ claim: { status: 'confirmed', tx_hash: existing.data.tx_hash } })
  const reconciliation = await reconcileVyrClaim({ arena: arenaId, epoch: BigInt(epoch), wallet: normalized as `0x${string}`, txHash: txHash as `0x${string}` })
  if (reconciliation.status === 'invalid') return NextResponse.json({ error: reconciliation.reason }, { status: 400 })
  const persistedStatus = reconciliation.status === 'confirmed' ? 'confirmed' : reconciliation.status === 'failed' ? 'failed' : 'pending'

  // FINDING (medium, remediated): points and amount were taken straight from the request body and
  // persisted into a financial table, so an authenticated caller could write arbitrary values into
  // its own claim row. `amount` is now derived from the chain via getEpochInfo/getPercentages, and
  // `points` is no longer client-settable at all: it is preserved if a row exists, and written as 0
  // on first insert. Nothing in this repo reads vyr_claims.points, so 0 is not a regression; the
  // authoritative value belongs to the reward engine, which should populate it.
  let chainAmount = '0'
  const rewardsAddress = VYNAR_REWARDS_V3_ADDRESS
  if (rewardsAddress) {
    try {
      const [info, percentages] = await Promise.all([
        withRpcRead('vyr.claim.write.epoch', requestId, (client) => client.readContract({ address: rewardsAddress, abi: vynarRewardsV3Abi, functionName: 'getEpochInfo', args: [arenaId, BigInt(epoch)] })),
        withRpcRead('vyr.claim.write.percentages', requestId, (client) => client.readContract({ address: rewardsAddress, abi: vynarRewardsV3Abi, functionName: 'getPercentages', args: [arenaId, BigInt(epoch)] })),
      ])
      const rank = info[2].findIndex((winner) => winner.toLowerCase() === normalized)
      if (rank >= 0 && rank < percentages.length) chainAmount = ((info[0] * percentages[rank]) / BigInt(10000)).toString()
    } catch (error) {
      logOperationalError('incentive.claim_status.amount_derivation', requestId, error)
      // Leave chainAmount at 0 rather than falling back to anything the caller supplied.
    }
  }

  const update = { tx_hash: txHash, status: persistedStatus, submitted_at: persistedStatus === 'pending' ? new Date().toISOString() : undefined, confirmed_at: persistedStatus === 'confirmed' ? new Date().toISOString() : undefined, failed_at: persistedStatus === 'failed' ? new Date().toISOString() : undefined, error_code: typeof body.errorCode === 'string' ? body.errorCode.slice(0, 80) : null, error_message: typeof body.errorMessage === 'string' ? body.errorMessage.slice(0, 500) : null }
  const { data, error } = await db.from('vyr_claims').upsert({ epoch, arena_type: arenaType, wallet: normalized, points: existing.data?.points ?? '0', amount: existing.data?.amount ?? chainAmount, ...update }, { onConflict: 'epoch,arena_type,wallet' }).select('status,tx_hash').single()
  if (error) return NextResponse.json({ error: 'CLAIM_STATUS_UNAVAILABLE' }, { status: 503 })
  return NextResponse.json({ claim: data }, { headers: { 'Cache-Control': 'private, no-store' } })
}