export type EpochStatus = 'OPEN' | 'CLOSING' | 'CLOSED' | 'INACTIVE' | 'LOADING' | 'ERROR'

export type EpochChainState = {
  currentEpoch: bigint
  epochStart: bigint
  epochEnd: bigint
  active: boolean
  closed: boolean
  pool: bigint
  prizePool: bigint
}

export function getEpochStatus(state: EpochChainState | null | undefined, nowSeconds: bigint): EpochStatus {
  if (!state) return 'LOADING'
  if (!state.active) return 'INACTIVE'
  if (state.closed) return 'CLOSED'
  if (nowSeconds >= state.epochEnd) return 'CLOSING'
  return 'OPEN'
}

export function canAcceptEntry(state: EpochChainState | null | undefined, nowSeconds: bigint, minimumSeconds = 30): boolean {
  return getEpochStatus(state, nowSeconds) === 'OPEN' && state !== null && state !== undefined && state.epochEnd - nowSeconds >= BigInt(minimumSeconds)
}

export function isTopThree(address: string | undefined, entries: readonly { player: string; score: bigint }[]): number | null {
  if (!address) return null
  const index = entries.findIndex((entry) => entry.player.toLowerCase() === address.toLowerCase())
  return index >= 0 && index < 3 ? index + 1 : null
}
