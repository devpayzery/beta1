import 'server-only'

import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { createAdminClient } from '@/lib/supabase/admin'
import { arcadeVaultV6Abi, arcadeVaultV6Address } from '@/lib/arcade-vault-v6-abi'
import { arenaById, ARENA_IDS, type ArenaId, type ArenaType } from '@/lib/arcade-arenas'
import { readEpochResult } from '@/lib/server-blockchain'
import { withRpcRead } from '@/lib/rpc-manager'
import { reconcileRankedPlayers } from '@/lib/reward-reconciliation'
import { VYR_EPOCH_POOL_WEI } from '@/lib/server-env'

type RankedPlayer = { rank: number; wallet: Address; score: bigint }

/**
 * POR QUE ESTA TABLA YA NO ES LA FUENTE DEL REPARTO
 *
 * Antes, el reparto SVP se calculaba aqui con 70/20/10 fijos. ArcadeVaultV6 congela el reparto
 * al cerrar la epoch en `svpBps[]`, sobre los slots REALMENTE poblados: 1 jugador se lleva el
 * 100%, 2 jugadores 70/30, 3 jugadores 70/20/10. Es decir, el reparto depende de cuantos
 * jugadores hubo, y no de una constante.
 *
 * Si la app siguiera suponiendo 70/20/10 crearia `svp_reward_allocations` con importes que no
 * son los que la cadena pago: con un solo jugador la cadena reparte el 100% y la app
 * registraria el 70%, y la fila de `claimed` se cerraria contra un importe imposible. Los bps
 * se leen de la cadena y esta tabla queda solo como asercion.
 */
const MAX_TOP = 10
const MAX_PODIUM = 3

/** Subconjunto de `svpBps[]` con los slots poblados, ya normalizado a basis points. */
function payoutPlan(bps: readonly bigint[], winnerCount: number) {
  const slots = bps.slice(0, Math.min(Number(winnerCount), MAX_PODIUM))
  if (slots.length < 1) throw new Error('SVP_NO_WINNERS')
  return slots.map((value, index) => ({ rank: index + 1, bps: value }))
}

function normalizePlayers(players: readonly Address[], scores: readonly bigint[], limit: number): RankedPlayer[] {
  return players.slice(0, limit).map((wallet, index) => ({ rank: index + 1, wallet: getAddress(wallet), score: scores[index] ?? BigInt(0) }))
}

async function getOrCreateImmutable(table: 'vyr_chain_snapshots' | 'svp_epoch_snapshots', value: Record<string, unknown>, epoch: bigint, arena: ArenaId) {
  const db = createAdminClient()
  const inserted = await db.from(table).insert(value).select('*').single()
  if (!inserted.error) return { row: inserted.data, created: true }
  const existing = await db.from(table).select('*').eq('epoch', epoch.toString()).eq('arena', arena).maybeSingle()
  if (existing.error || !existing.data) throw inserted.error
  const same = JSON.stringify(existing.data.prize_pool) === JSON.stringify(value.prize_pool)
    && JSON.stringify(existing.data.top10) === JSON.stringify(value.top10)
    && (table === 'svp_epoch_snapshots' || JSON.stringify(existing.data.epoch) === JSON.stringify(value.epoch))
  if (!same) {
    await db.from(table).update(table === 'vyr_chain_snapshots' ? { status: 'mismatch', reconciliation_status: 'mismatch' } : { status: 'reconciliation_required' }).eq('id', existing.data.id)
    throw new Error(table === 'vyr_chain_snapshots' ? 'VYR_SNAPSHOT_IMMUTABLE_MISMATCH' : 'SVP_SNAPSHOT_IMMUTABLE_MISMATCH')
  }
  return { row: existing.data, created: false }
}

export async function readFinalTop10(epoch: bigint, arena: ArenaId, requestId = crypto.randomUUID()) {
  // `getTop10` devuelve dos arrays FIJOS de 10, no un array variable. Slots no poblados vienen
  // como address(0) / 0, y por eso hay que truncar por `winnerCount` y descartar los ceros en
  // vez de confiar en la longitud.
  const raw = await withRpcRead('vault.getTop10', requestId, (client) => client.readContract({ address: arcadeVaultV6Address, abi: arcadeVaultV6Abi, functionName: 'getTop10', args: [arena, epoch] }))
  const [players, scores] = raw
  const populated = players.reduce((count, wallet) => (wallet === '0x0000000000000000000000000000000000000000' ? count : count + 1), 0)
  const top = normalizePlayers(players, scores, populated)
  if (populated < 1 || populated > MAX_TOP) throw new Error('TOP10_INVALID')
  if (top.length < 1 || top.length > MAX_TOP || top.some((player, index) => player.rank !== index + 1 || player.score < BigInt(0)) || new Set(top.map((player) => player.wallet.toLowerCase())).size !== top.length) throw new Error('TOP10_INVALID')
  return top
}

export async function finalizeVyrEpoch(epoch: bigint, arena: ArenaId, requestId = crypto.randomUUID()) {
  const top10 = await readFinalTop10(epoch, arena, requestId)
  const top10Json = top10.map((player) => ({ rank: player.rank, wallet: player.wallet, score: player.score.toString() }))
  const snapshot = await getOrCreateImmutable('vyr_chain_snapshots', { epoch: epoch.toString(), arena, prize_pool: VYR_EPOCH_POOL_WEI.toString(), top10: top10Json, status: 'snapshotted' }, epoch, arena)
  const db = createAdminClient()
  // FINDING (high, remediated): this read arcade_scores directly, which returns one row per
  // session. A wallet with several sessions in the epoch therefore occupied several leaderboard
  // slots, and the ranking was computed over rows the chain does not consider distinct — the
  // chain's getTop10 ranks the personal best per player. arcade_scores_best is exactly "best
  // recorded score per (epoch, arena_type, wallet)", so the DB ranking now mirrors the chain.
  //
  // FINDING (medium, remediated): the query also had no arena_type filter, so scores from one
  // arena could be reconciled against the winners of another and raise a spurious
  // VYR_SNAPSHOT_RECONCILIATION_MISMATCH, failing the epoch closure. Con tres modos el filtro
  // pasa a ser obligatorio y no opcional: cada arena se cierra por separado.
  const arenaType: ArenaType | undefined = arenaById(arena)?.type
  if (!arenaType) throw new Error('UNKNOWN_ARENA')
  const scores = await db.from('arcade_scores_best').select('wallet,score').eq('arena_type', arenaType).eq('epoch', epoch.toString()).order('score', { ascending: false }).limit(MAX_TOP)
  if (scores.error) throw scores.error
  const dbPlayers = (scores.data ?? []).map((row, index) => ({ rank: index + 1, wallet: getAddress(String(row.wallet)), score: BigInt(row.score) }))
  const reconciliation = reconcileRankedPlayers(top10, dbPlayers, MAX_TOP)
  if (reconciliation.some((state) => state !== 'MATCH' && state !== 'CHAIN_ONLY')) {
    await db.from('vyr_chain_snapshots').update({ reconciliation_status: 'mismatch', reconciliation, status: 'mismatch' }).eq('id', snapshot.row.id)
    throw new Error('VYR_SNAPSHOT_RECONCILIATION_MISMATCH')
  }
  await db.from('vyr_chain_snapshots').update({ reconciliation_status: 'matched', reconciliation }).eq('id', snapshot.row.id)
  return { snapshot: snapshot.row, top10, pool: VYR_EPOCH_POOL_WEI, reconciliation, arena }
}

export async function finalizeSvpEpoch(epoch: bigint, arena: ArenaId, requestId = crypto.randomUUID()) {
  const [result, top10] = await Promise.all([
    readEpochResult(epoch, arena, requestId),
    readFinalTop10(epoch, arena, requestId),
  ])
  if (!result.closed) throw new Error('SVP_EPOCH_NOT_CLOSED')
  if (result.voided) throw new Error('SVP_EPOCH_VOIDED')
  const podium = top10.slice(0, MAX_PODIUM)
  // El numero de ganadores lo fija la cadena al cerrar, no la longitud de la lista.
  const plan = payoutPlan(result.bps, Number(result.winnerCount))
  if (plan.length < 1) throw new Error('SVP_TOP_REQUIRED')
  if (podium.length < plan.length) throw new Error('SVP_TOP_REQUIRED')
  const rewards = plan.map((slot) => ({ ...slot, player: podium[slot.rank - 1], amount: (result.prizePool * slot.bps) / BigInt(100) }))
  // Invariante que el reparto dynamic no puede violar: lo pagado nunca supera el premio.
  const sum = rewards.reduce((acc, r) => acc + r.amount, BigInt(0))
  if (sum > result.prizePool) throw new Error('SVP_ALLOCATION_EXCEEDS_POOL')
  const top3Json = rewards.map((entry) => ({ rank: entry.rank, wallet: entry.player.wallet, score: entry.player.score.toString(), bps: entry.bps.toString(), reward: entry.amount.toString() }))
  const snapshot = await getOrCreateImmutable('svp_epoch_snapshots', { epoch: epoch.toString(), arena, prize_pool: result.prizePool.toString(), onchain_result: { closed: true, voided: result.voided, paidOut: result.paidOut.toString(), bps: plan.map((slot) => slot.bps.toString()) }, top10: top3Json, status: 'snapshotted' }, epoch, arena)
  const db = createAdminClient()
  const allocations = rewards.map((entry) => ({ snapshot_id: snapshot.row.id, epoch: epoch.toString(), arena, rank: entry.rank, wallet: entry.player.wallet.toLowerCase(), prize_pool: result.prizePool.toString(), reward_amount: entry.amount.toString() }))
  const inserted = await db.from('svp_reward_allocations').insert(allocations)
  if (inserted.error && !/duplicate|unique/i.test(inserted.error.message)) throw inserted.error
  return { epoch, arena, pool: result.prizePool, bps: plan.map((slot) => slot.bps), allocations: rewards.map((entry) => ({ rank: entry.rank, wallet: entry.player.wallet, bps: entry.bps, amount: entry.amount })) }
}

export async function reconcileSvpClaim(input: { epoch: bigint; arena: ArenaId; wallet: Address; txHash: Hex }, requestId = crypto.randomUUID()) {
  const db = createAdminClient()
  const allocation = await db.from('svp_reward_allocations').select('id').eq('epoch', input.epoch.toString()).eq('arena', input.arena).eq('wallet', input.wallet.toLowerCase()).maybeSingle()
  if (allocation.error || !allocation.data) return { status: 'invalid' as const, reason: 'SVP_ALLOCATION_NOT_FOUND' }
  const transaction = await withRpcRead('vault.claim.tx', requestId, (client) => client.getTransaction({ hash: input.txHash }))
  const receipt = await withRpcRead('vault.claim.receipt', requestId, (client) => client.getTransactionReceipt({ hash: input.txHash }))
  const expectedData = encodeFunctionData({ abi: arcadeVaultV6Abi, functionName: 'claimPrize', args: [input.arena, input.epoch] })
  if (transaction.to?.toLowerCase() !== arcadeVaultV6Address.toLowerCase() || transaction.from.toLowerCase() !== input.wallet.toLowerCase() || transaction.input !== expectedData || receipt.status !== 'success') return { status: 'invalid' as const, reason: 'SVP_CLAIM_TRANSACTION_INVALID' }
  const claimed = await withRpcRead('vault.claimed.svp', requestId, (client) => client.readContract({ address: arcadeVaultV6Address, abi: arcadeVaultV6Abi, functionName: 'claimed', args: [input.arena, input.epoch, input.wallet] }))
  if (!claimed) return { status: 'pending' as const }
  await db.from('svp_reward_allocations').update({ claimed: true, claim_tx_hash: input.txHash, confirmed_at: new Date().toISOString() }).eq('id', allocation.data.id)
  return { status: 'confirmed' as const }
}

/**
 * Asercion pura del reparto, para test. NO calcula el reparto: los bps vienen de la cadena.
 * Se conserva como funcion pura para poder fijar en un test que, dados unos bps y un premio,
 * la suma de los premios nunca lo supera.
 */
export function validateSvpFormula(pool: bigint, entries: readonly { bps: bigint; amount: bigint }[]) {
  if (entries.length < 1 || entries.length > MAX_PODIUM) return false
  const sum = entries.reduce((acc, entry) => acc + entry.amount, BigInt(0))
  if (sum > pool) return false
  return entries.every((entry) => entry.amount === (pool * entry.bps) / BigInt(100))
}

export { MAX_PODIUM, MAX_TOP, ARENA_IDS, payoutPlan }