import { isAddress, zeroAddress } from 'viem'
import { apiError } from '@/lib/arcade-types'
import { arenaByType, parseArenaParam, type ArenaType } from '@/lib/arcade-arenas'
import { consumeLimit, rateLimitResponse, requestIp } from '@/lib/rate-limit'
import { createAdminClient } from '@/lib/supabase/admin'
import { readArena, readEpochResult, readTop10 } from '@/lib/server-blockchain'

export const runtime = 'nodejs'

type ChainEntry = { player: `0x${string}`; score: bigint }

export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const ipLimit = await consumeLimit('leaderboard_ip', requestIp(request))
    if (!ipLimit.allowed) return rateLimitResponse(requestId, ipLimit.retryAfter)
  } catch (error) {
    console.error('[arcade] leaderboard rate limit unavailable', error instanceof Error ? error.message : 'unknown error')
    return apiError('CHAIN_UNAVAILABLE', 'Request controls are unavailable.', 503, requestId)
  }

  const url = new URL(request.url)
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 25)))
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0))
  const requestedEpoch = url.searchParams.get('epoch')
  // El modo es obligatorio en la URL. Un leaderboard sin modo serian el de human por defecto, y
  // con tres modos ese default es una forma silenciosa de que el cliente pinte el ranking de
  // human mientras cree que esta viendo otro.
  const arenaType = parseArenaParam(url.searchParams.get('arena'))
  const arenaConfig = arenaType ? arenaByType(arenaType) : undefined
  if (!arenaType || !arenaConfig) {
    return apiError('INVALID_JSON', 'Arena, epoch, or pagination parameters are invalid.', 400, requestId)
  }
  if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 1 || offset < 0 || !requestedEpoch || !/^\d+$/.test(requestedEpoch)) {
    return apiError('INVALID_JSON', 'Arena, epoch, or pagination parameters are invalid.', 400, requestId)
  }

  const rpcStartedAt = Date.now()
  let rpcCalls = 0
  let rpcFailures = 0
  const readRpc = async <T>(read: Promise<T>) => { rpcCalls += 1; try { return await read } catch (error) { rpcFailures += 1; throw error } }
  try {
    const arena = await readRpc(readArena(arenaConfig.id, requestId))
    const epoch = BigInt(requestedEpoch)
    if (epoch > arena.currentEpoch) return apiError('INVALID_JSON', 'The requested epoch does not exist.', 400, requestId)
    const resolvedEpoch = epoch
    const result = await readRpc(readEpochResult(resolvedEpoch, arenaConfig.id, requestId))
    console.info(JSON.stringify({ event: 'leaderboard_epoch_resolved', requestId, arena: arenaType, requestedEpoch: epoch.toString(), returnedEpoch: resolvedEpoch.toString() }))
    // getTop10 devuelve dos arrays FIJOS de 10. Los slots no poblados llegan como
    // address(0)/0 y hay que descartarlos por valor, no confiar en la longitud.
    const [players, scores] = await readRpc(readTop10(resolvedEpoch, arenaConfig.id, requestId))
    const chainEntries = players.map((player, index) => ({ player, score: scores[index] ?? BigInt(0) }))
      .filter((entry): entry is ChainEntry => isAddress(entry.player) && entry.player !== zeroAddress && entry.score > BigInt(0))
      .filter((entry, index, list) => list.findIndex((candidate) => candidate.player.toLowerCase() === entry.player.toLowerCase()) === index)
    const chainWallets = new Set(chainEntries.map((entry) => entry.player.toLowerCase()))
    let databaseEntries: ChainEntry[] = []
    // FINDING (high, remediated): this used to read the arcade_scores *table* through the anon key.
    // Two problems: the table's FOR SELECT policy exposed the whole row including the gameplay
    // event log to anon, and the raw table has one row per session, so a wallet with several
    // attempts in the epoch occupied several leaderboard slots — which the in-memory
    // `findIndex(...) === index` dedup only papered over. arcade_scores_best is one row per
    // (epoch, arena_type, wallet), i.e. the chain's personal-best semantics, and it is read here
    // through the service-role client so no anon grant on the base table is needed.
    //
    // The arena_type filter was previously hardcoded to 'human', which with more than one mode
    // mixed every mode's best scores into every mode's leaderboard.
    if (chainEntries.length < 10) {
      const { data } = await createAdminClient().from('arcade_scores_best').select('wallet,score').eq('arena_type', arenaType).eq('epoch', resolvedEpoch.toString()).order('score', { ascending: false }).limit(100)
      databaseEntries = (data ?? []).filter((entry) => isAddress(entry.wallet) && !chainWallets.has(entry.wallet.toLowerCase()) && Number(entry.score) > 0).map((entry) => ({ player: entry.wallet as `0x${string}`, score: BigInt(entry.score) }))
    }
    const mergedEntries = [...chainEntries, ...databaseEntries].sort((a, b) => a.score === b.score ? 0 : a.score > b.score ? -1 : 1).filter((entry, index, list) => list.findIndex((candidate) => candidate.player.toLowerCase() === entry.player.toLowerCase()) === index)
      .slice(offset, offset + limit)
      .map((entry, index) => ({ arena_type: arenaType as ArenaType, epoch: resolvedEpoch.toString(), wallet: entry.player, score: entry.score.toString(), position: offset + index + 1, tx_hash: null, created_at: null }))
    const durationMs = Date.now() - rpcStartedAt
    console.info(JSON.stringify({ event: 'leaderboard.read_metrics', requestId, arena: arenaType, rpcCalls, rpcFailures, durationMs }))
    return Response.json({ entries: mergedEntries, arena: arenaType, epoch: resolvedEpoch.toString(), requestedEpoch: epoch.toString(), resolvedEpoch: resolvedEpoch.toString(), closed: result.closed, prizePool: result.prizePool.toString(), currentEpoch: arena.currentEpoch.toString(), updatedAt: new Date().toISOString(), requestId }, { headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30', 'X-Request-Id': requestId } })
  } catch (error) {
    // Same rationale as the primary path: read the per-wallet-best view through the service-role
    // client instead of falling back to an anon-key read of the base table.
    if (requestedEpoch) {
      const { data } = await createAdminClient().from('arcade_scores_best').select('wallet,score,tx_hash,created_at').eq('arena_type', arenaType).eq('epoch', requestedEpoch).order('score', { ascending: false }).limit(100)
      const entries = (data ?? []).filter((entry) => isAddress(entry.wallet) && Number(entry.score) > 0).slice(offset, offset + limit).map((entry, index) => ({ arena_type: arenaType as ArenaType, epoch: requestedEpoch, wallet: entry.wallet, score: String(entry.score), position: offset + index + 1, tx_hash: entry.tx_hash ?? null, created_at: entry.created_at ?? null }))
      return Response.json({ entries, arena: arenaType, epoch: requestedEpoch, requestedEpoch, resolvedEpoch: requestedEpoch, closed: false, prizePool: '0', currentEpoch: requestedEpoch, updatedAt: new Date().toISOString(), requestId, source: 'database-fallback' }, { headers: { 'Cache-Control': 'public, s-maxage=10', 'X-Request-Id': requestId } })
    }
    console.error(JSON.stringify({ event: 'leaderboard.read_failed', requestId, errorCode: 'CHAIN_UNAVAILABLE', error: error instanceof Error ? error.message : String(error) }))
    return apiError('CHAIN_UNAVAILABLE', 'Unable to load on-chain data.', 503, requestId)
  }
}