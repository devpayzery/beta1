export type VyrPublishCatchStatus = 'published' | 'mismatch' | 'publishing' | 'failed'

export function publishCatchTransition(status: VyrPublishCatchStatus): 'return_published' | 'throw_mismatch' | 'return_publishing' | 'mark_failed' {
  if (status === 'published') return 'return_published'
  if (status === 'mismatch') return 'throw_mismatch'
  if (status === 'publishing') return 'return_publishing'
  return 'mark_failed'
}
