import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { consumeLimit, rateLimitResponse, requestIp } from '@/lib/rate-limit'
import { logOperationalError } from '@/lib/server-log'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  // FINDING (medium, remediated): this route had no rate limiting at all.
  try {
    const limit = await consumeLimit('incentive_epochs_ip', requestIp(request))
    if (!limit.allowed) return rateLimitResponse(requestId, limit.retryAfter)
  } catch (error) {
    logOperationalError('incentive.epochs.rate_limit', requestId, error)
    return NextResponse.json({ error: 'RATE_LIMIT_UNAVAILABLE', requestId }, { status: 503 })
  }
  // vyr_chain_snapshots_wei casts numeric(78,0) prize_pool to text; PostgREST would otherwise
  // serialise it as a JSON number and round anything above 2^53.
  const { data, error } = await createAdminClient().from('vyr_chain_snapshots_wei').select('epoch,arena,prize_pool,top10,status,reconciliation_status,created_at').eq('status', 'confirmed').order('epoch', { ascending: false }).limit(100)
  if (error) return NextResponse.json({ error: 'INCENTIVE_UNAVAILABLE' }, { status: 503 })
  return NextResponse.json({ snapshots: (data ?? []).map((row) => ({ ...row, epoch: String(row.epoch), prize_pool: String(row.prize_pool) })) }, { headers: { 'Cache-Control': 'public, max-age=15, stale-while-revalidate=60' } })
}