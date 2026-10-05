export type SubmissionFailure = { submittedTxHash?: `0x${string}`; chainTransactionFailed: boolean; writeOutcomeUncertain?: boolean }

export function shouldKeepSubmissionPending({ submittedTxHash, chainTransactionFailed, writeOutcomeUncertain }: SubmissionFailure): boolean {
  return !chainTransactionFailed && (Boolean(submittedTxHash) || Boolean(writeOutcomeUncertain))
}

export type PersistedScoreStatus = 'submitting' | 'recorded' | 'pending_mint' | 'failed'

export function persistedScoreTransition(status: PersistedScoreStatus): 'recorded' | 'failed' | 'reconcile_receipt' | 'pending' {
  if (status === 'recorded') return 'recorded'
  if (status === 'failed') return 'failed'
  return 'reconcile_receipt'
}

export type ReceiptOutcome = 'success' | 'reverted' | 'pending'

export function reconciliationTransition(outcome: ReceiptOutcome): 'recorded' | 'failed' | 'pending' {
  if (outcome === 'success') return 'recorded'
  if (outcome === 'reverted') return 'failed'
  return 'pending'
}
