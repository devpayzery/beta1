import { NextResponse } from 'next/server'
import { authorizeCronRequest, getCronAuthResponse } from '@/lib/cron-auth'
import { publishVyrEpoch } from '@/lib/vyr-publisher'
import { ARENAS, isPlayable } from '@/lib/arcade-arenas'
import { currentEpoch } from '@/lib/server-blockchain'
import { consumeLimit, rateLimitResponse, requestIp } from '@/lib/rate-limit'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  const auth = authorizeCronRequest(request, process.env.CRON_SECRET)
  if (!auth.ok) return getCronAuthResponse(auth, requestId)
  try {
    const limit = await consumeLimit('cron_ip', requestIp(request))
    if (!limit.allowed) return rateLimitResponse(requestId, limit.retryAfter)
  } catch {
    return NextResponse.json({ error: 'RATE_LIMIT_UNAVAILABLE', requestId }, { status: 503 })
  }

  // Publica los premios VYNAR de la epoch anterior, en todas las arenas. La lista sale del
  // registro: cada arena tiene su propio ciclo de epochs y su propio reparto de VYNAR, asi que
  // publicar solo una dejaria a los jugadores de los otros modos sin reclamar su parte.
  const targets = ARENAS.filter((arena) => arena.playable && isPlayable(arena.type))
  const results: Record<string, unknown>[] = []
  for (const target of targets) {
    try {
      const epoch = await currentEpoch(target.id, requestId)
      const result = await publishVyrEpoch(epoch > BigInt(0) ? epoch - BigInt(1) : epoch, target.id, requestId)
      results.push({ arena: target.type, status: 'ok', result })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(JSON.stringify({ event: 'vynar_epoch_sync_failed', requestId, arena: target.type, error: detail }))
      results.push({ arena: target.type, status: 'failed', error: detail })
    }
  }
  return NextResponse.json({ arenas: results, failed: results.filter((entry) => entry.status === 'failed').length, requestId }, { status: 200 })
}