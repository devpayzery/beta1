import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { getTrustedClientIp } from '@/lib/trusted-client-ip'

type LimitResult = { allowed: boolean; remaining: number; retryAfter: number }

const limits: Record<string, { limit: number; windowSeconds: number }> = {
  play_ip: { limit: 30, windowSeconds: 60 },
  play_wallet: { limit: 10, windowSeconds: 60 },
  play_tx: { limit: 2, windowSeconds: 300 },
  finish_ip: { limit: 20, windowSeconds: 60 },
  finish_wallet: { limit: 10, windowSeconds: 60 },
  finish_session: { limit: 3, windowSeconds: 60 },
  confirm_score_ip: { limit: 20, windowSeconds: 60 },
  confirm_score_session: { limit: 5, windowSeconds: 300 },
  leaderboard_ip: { limit: 30, windowSeconds: 60 },
  incentive_ip: { limit: 30, windowSeconds: 60 },
  history_ip: { limit: 30, windowSeconds: 60 },
  cron_ip: { limit: 10, windowSeconds: 60 },
  // FINDING (medium, remediated): incentive/{claim-status,epochs,rewards} had no consumeLimit call at
  // all, so an anonymous caller could loop them freely. claim-status additionally performs a write.
  incentive_claim_ip: { limit: 20, windowSeconds: 60 },
  incentive_epochs_ip: { limit: 30, windowSeconds: 60 },
  incentive_rewards_ip: { limit: 30, windowSeconds: 60 },
  // Wallet sign-in. Every call either writes a challenge row or performs an ECDSA recovery, so the
  // ceiling is deliberately low.
  auth_ip: { limit: 15, windowSeconds: 60 },
}

export { getTrustedClientIp }
export const requestIp = getTrustedClientIp

export async function consumeLimit(bucket: keyof typeof limits, subject: string): Promise<LimitResult> {
  const config = limits[bucket]
  const { data, error } = await createAdminClient().rpc('consume_arcade_rate_limit', {
    p_bucket: bucket,
    p_subject: subject.slice(0, 200),
    p_limit: config.limit,
    p_window_seconds: config.windowSeconds,
  })
  if (error || !data?.[0]) throw error ?? new Error('RATE_LIMIT_UNAVAILABLE')
  return { allowed: Boolean(data[0].allowed), remaining: Number(data[0].remaining), retryAfter: Number(data[0].retry_after) }
}

export function rateLimitResponse(requestId: string, retryAfter: number) {
  return Response.json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' }, requestId }, { status: 429, headers: { 'Retry-After': String(Math.max(1, retryAfter)), 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + Math.max(1, retryAfter)) } })
}
