import type { ApiErrorCode } from './arcade-types'

export const PLAY_ERROR_STATES: Partial<Record<ApiErrorCode, { title: string; message: string; action: string }>> = {
  INVALID_PAYMENT: { title: 'Invalid payment', message: 'The payment could not be verified.', action: 'Review payment' },
  PAYMENT_REPLAY: { title: 'Payment already used', message: 'This payment was already used for a game.', action: 'Request another game' },
  PAYMENT_PERSISTENCE_FAILED: { title: 'Payment not recorded', message: 'We could not record the payment. Keep the same payment and retry.', action: 'Retry with the same payment' },
  EPOCH_READ_FAILED: { title: 'Epoch unavailable', message: 'We could not read the current epoch. Try again.', action: 'Retry' },
  SESSION_CREATE_FAILED: { title: 'Payment confirmed, game not started', message: 'Your payment is confirmed, but the game could not be started.', action: 'Recover game' },
  SESSION_EXPIRED: { title: 'Session expired', message: 'The session expired. Request a new game.', action: 'Request a new game' },
  CHAIN_UNAVAILABLE: { title: 'Network temporarily unavailable', message: 'We could not verify the transaction on the network. Try again.', action: 'Retry' },
  CONTRACT_MISMATCH: { title: 'Incompatible contract', message: 'The configured deployment does not expose the expected ArcadeVaultV3 interface. Payment will not be processed.', action: 'Do not pay; review deployment' },
}

export function getPlayErrorState(code: string | undefined, safeMessage?: string) {
  if (code === 'CONTRACT_MISMATCH' && safeMessage) return { title: 'Incompatible contract', message: safeMessage, action: 'Do not pay; review deployment' }
  return PLAY_ERROR_STATES[code as ApiErrorCode] ?? { title: 'Temporary error', message: safeMessage ?? 'We could not start the game. Try again.', action: 'Retry' }
}

export function getWeb3ErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes('user rejected') || message.includes('user denied') || message.includes('rejected')) return 'Transaction cancelled.'
  if (message.includes('chain') || message.includes('network')) return 'Connect your wallet to SVP Chain testnet (2517).'
  if (message.includes('insufficient funds')) return 'Insufficient funds to complete this transaction.'
  if (message.includes('already claimed')) return 'This prize has already been claimed.'
  if (message.includes('not a winner') || message.includes('winner')) return 'You do not have a pending prize.'
  if (message.includes('not closed') || message.includes('closed')) return 'The epoch is not closed yet.'
  if (message.includes('rpc') || message.includes('timeout') || message.includes('network request failed')) return 'The network could not be reached.'
  return 'The transaction could not be completed. Try again.'
}
