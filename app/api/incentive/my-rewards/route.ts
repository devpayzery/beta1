import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { consumeLimit, rateLimitResponse, requestIp } from '@/lib/rate-limit'
import { requireWalletSession } from '@/lib/wallet-auth'
import { withRpcRead } from '@/lib/rpc-manager'
import { logOperationalError } from '@/lib/server-log'
import { VYNAR_REWARDS_V3_ADDRESS } from '@/lib/vynar-config'
import { vynarRewardsV3Abi } from '@/lib/vynar-rewards-v3-abi'
import { ARENAS, isPlayable, type ArenaConfig } from '@/lib/arcade-arenas'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const limit = await consumeLimit('incentive_ip', requestIp(request))
    if (!limit.allowed) return rateLimitResponse(requestId, limit.retryAfter)
  } catch (error) {
    logOperationalError('incentive.my_rewards.rate_limit', requestId, error)
    return NextResponse.json({ error: 'RATE_LIMIT_UNAVAILABLE', requestId }, { status: 503 })
  }
  // FINDING (critical, remediated): `?wallet=` was self-asserted and every read went through the
  // service-role client, which has BYPASSRLS. Signing in for the same wallet is now required.
  const session = requireWalletSession(request, new URL(request.url).searchParams.get('wallet'))
  if ('error' in session) return session.error
  const wallet = session.wallet

  // FINDING (medium, remediated): every published snapshot was iterated and each one issued two RPC
  // reads (getEpochInfo + getPercentages), so cost scaled with total epoch history and was unbounded
  // for an anonymous caller. Only the most recent MAX_EPOCHS_SCAN snapshots are considered, and the
  // caller's own claim rows are used to short-circuit epochs that cannot contain a win.
  const MAX_EPOCHS_SCAN = 10
  const playgrounds = ARENAS.filter((arena) => arena.playable && isPlayable(arena.type))
  const db = createAdminClient()

  // Esta ruta devuelve los premios de TODOS los modos, no solo de uno. Por eso los indices de
  // abajo son por (epoch, arena) y no por epoch: con tres arenas hay tres snapshots por epoch, y
  // un `Map` indexado solo por epoch dejaba que la fila de medium se sobrepusiera a la de human.
  // El bug no habria dado ningun error: habria mostrado el premio del modo equivocado.
  const arenaIds = playgrounds.map((arena) => arena.id)
  const [vyr, claims, svp, entries] = await Promise.all([
    db.from('vyr_chain_snapshots').select('epoch,arena,top10,status').in('arena', arenaIds).eq('status', 'confirmed').order('epoch', { ascending: false }).limit(MAX_EPOCHS_SCAN * arenaIds.length),
    db.from('vyr_claims').select('epoch,arena_type,status,tx_hash').eq('wallet', wallet).in('arena_type', playgrounds.map((arena) => arena.type)),
    // s..._wei casts numeric(78,0) prize_pool / reward_amount to text to avoid PostgREST's lossy
    // JSON-number serialisation of large wei amounts.
    db.from('svp_reward_allocations_wei').select('epoch,arena,rank,prize_pool,reward_amount,claimed,claim_tx_hash,confirmed_at').eq('wallet', wallet).in('arena', arenaIds).order('epoch', { ascending: false }),
    db.from('arcade_scores_best').select('epoch,arena_type,score,tx_hash,created_at').eq('wallet', wallet).order('created_at', { ascending: false }).limit(100),
  ])
  if (vyr.error || claims.error || svp.error || entries.error) return NextResponse.json({ error: 'REWARDS_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } })
  // La clave de estos mapas es el `ArenaId` del registro, no un `number` suelto. Las tablas
  // guardan el id on-chain en `smallint` (arena) y el texto (arena_type), y `Number(...)` sobre
  // ambos devuelve `number`, que no se puede pasar a un contrato que espera `0|1|2|3`. Por eso se
  // busca en el registro: si la fila trae un id que no existe, la fila no se muestra en vez de
  // consultarse la cadena con un id que nadie definio.
const arenaByNumericId = new Map<number, ArenaConfig>(playgrounds.map((arena) => [arena.id, arena]))
  const arenaByTypeName = new Map<string, ArenaConfig>(playgrounds.map((arena) => [arena.type, arena]))
  const claimKey = (epoch: unknown, arenaType: unknown) => `${String(epoch)}:${String(arenaType)}`
  const claimByEpochAndArena = new Map((claims.data ?? []).map((claim) => [claimKey(claim.epoch, claim.arena_type), claim]))
  const rewardsAddress = VYNAR_REWARDS_V3_ADDRESS
  // Skip epochs the caller never appears in: the snapshot's top10 is already indexed data, so this
  // removes the RPC round trip for the overwhelmingly common "not a winner" case.
  const candidateEpochs = (vyr.data ?? []).filter((row) => (row.top10 as Array<{ wallet?: string }> | null)?.some((entry) => typeof entry?.wallet === 'string' && entry.wallet.toLowerCase() === wallet))
  const chainRewards = rewardsAddress ? await Promise.all(candidateEpochs.map(async (row) => {
    const arenaId = Number(row.arena)
    const arena = arenaByNumericId.get(arenaId)
    if (!arena) return null
    const epoch = BigInt(row.epoch)
    const [info, percentages] = await Promise.all([
      withRpcRead('incentive.vyr.epoch', requestId, (client) => client.readContract({ address: rewardsAddress, abi: vynarRewardsV3Abi, functionName: 'getEpochInfo', args: [arena.id, epoch] })),
      withRpcRead('incentive.vyr.percentages', requestId, (client) => client.readContract({ address: rewardsAddress, abi: vynarRewardsV3Abi, functionName: 'getPercentages', args: [arena.id, epoch] })),
    ])
    const position = info[2].findIndex((winner) => winner.toLowerCase() === wallet)
    if (position < 0 || position >= percentages.length) return null
    const claim = claimByEpochAndArena.get(claimKey(row.epoch, arena.type))
    return { epoch: String(row.epoch), arena: arenaId, arenaType: arena.type, rank: position + 1, score: String((row.top10 as Array<{ score: string }>)[position]?.score ?? '0'), amount: ((info[0] * percentages[position]) / BigInt(10000)).toString(), claimed: await withRpcRead('incentive.vyr.claimed', requestId, (client) => client.readContract({ address: rewardsAddress, abi: vynarRewardsV3Abi, functionName: 'claimed', args: [arena.id, epoch, wallet as `0x${string}`] })), claimStatus: claim?.status ?? null, txHash: claim?.tx_hash ?? null }
  })) : []
  return NextResponse.json({
    vyr: chainRewards.filter((row): row is NonNullable<typeof row> => Boolean(row)),
    svp: (svp.data ?? []).map((row) => ({ epoch: String(row.epoch), arena: Number(row.arena), arenaType: arenaByNumericId.get(Number(row.arena))?.type ?? null, rank: row.rank, prizePool: String(row.prize_pool), rewardAmount: String(row.reward_amount), claimStatus: row.claimed ? 'confirmed' : null, txHash: row.claim_tx_hash, confirmedAt: row.confirmed_at })),
    entries: (entries.data ?? []).map((row) => ({ epoch: String(row.epoch), arena: arenaByTypeName.get(String(row.arena_type))?.id ?? null, arenaType: row.arena_type, score: row.score, txHash: row.tx_hash, createdAt: row.created_at })),
  }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } })
}

export async function HEAD() { return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } }) }