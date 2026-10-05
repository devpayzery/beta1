import { NextResponse } from 'next/server'
import { consumeLimit, rateLimitResponse, requestIp } from '@/lib/rate-limit'
import { requireWalletSession } from '@/lib/wallet-auth'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const limit = await consumeLimit('history_ip', requestIp(request))
    if (!limit.allowed) return rateLimitResponse(requestId, limit.retryAfter)
  } catch {
    return NextResponse.json({ error: 'RATE_LIMIT_UNAVAILABLE', requestId }, { status: 503 })
  }

  // FINDING (critical, remediated): this used to read `?wallet=` at face value through the Supabase
  // *anon* key and return any address's history, and it silently returned an empty list whenever
  // Supabase env vars were missing — a shape that reads as "this wallet has no history" rather than
  // "history is unavailable". It now requires a signature-verified session for the same wallet and
  // reads through the service-role client, so the answer is scoped by construction rather than by RLS.
  const session = requireWalletSession(request, new URL(request.url).searchParams.get('wallet'))
  if ('error' in session) return session.error

  const db = createAdminClient()
  // arcade_scores_best, not arcade_scores: one row per (epoch, arena, wallet), which is what a
  // history view means. arcade_scores would list every attempt separately. The view already restricts
  // itself to status = 'recorded', so there is no status predicate to repeat here.
  const { data, error } = await db.from('arcade_scores_best').select('epoch,arena_type,score,tx_hash,created_at').eq('wallet', session.wallet).order('created_at', { ascending: false }).limit(20)
  if (error) return NextResponse.json({ error: 'HISTORY_UNAVAILABLE', requestId }, { status: 503 })
  return NextResponse.json({ entries: data ?? [] }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } })
}