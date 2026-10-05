export type RankedRecord = { rank: number; wallet: `0x${string}`; score: bigint }
export type ReconciliationState = 'MATCH' | 'CHAIN_ONLY' | 'DB_ONLY' | 'SCORE_MISMATCH' | 'RANK_MISMATCH'

export function reconcileRankedPlayers(chain: readonly RankedRecord[], db: readonly RankedRecord[], limit: number): ReconciliationState[] {
  const result: ReconciliationState[] = []
  for (let index = 0; index < limit; index += 1) {
    const chainPlayer = chain[index]
    const dbPlayer = db[index]
    if (chainPlayer && !dbPlayer) { result.push('CHAIN_ONLY'); continue }
    if (!chainPlayer && dbPlayer) { result.push('DB_ONLY'); continue }
    if (!chainPlayer || !dbPlayer) continue
    if (chainPlayer.rank !== dbPlayer.rank || chainPlayer.wallet.toLowerCase() !== dbPlayer.wallet.toLowerCase()) { result.push('RANK_MISMATCH'); continue }
    result.push(chainPlayer.score === dbPlayer.score ? 'MATCH' : 'SCORE_MISMATCH')
  }
  return result
}
