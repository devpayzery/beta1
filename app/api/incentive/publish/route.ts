import { NextResponse } from 'next/server'
import { publishVyrEpoch } from '@/lib/vyr-publisher'
import { authorizeCronRequest, getCronAuthResponse } from '@/lib/cron-auth'
import { ARENA_IDS, arenaById, type ArenaId } from '@/lib/arcade-arenas'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const requestId = crypto.randomUUID()
  const auth = authorizeCronRequest(request, process.env.CRON_SECRET)
  if (!auth.ok) return getCronAuthResponse(auth, requestId)
  try {
    const body = await request.json().catch(() => null) as { epoch?: unknown; arena?: unknown } | null
    if (!body || typeof body.epoch !== 'string' || !/^\d+$/.test(body.epoch)) return NextResponse.json({ error: 'INVALID_EPOCH', requestId }, { status: 400 })
    // `arena` es opcional y solo admite el id numerico del registro. Es opcional para no romper la
    // llamada existente, pero si se envia mal se rechaza en vez de caer a human en silencio:
    // publicar el reparto de una epoch contra la arena equivocada es exactamente el error que este
    // proyecto ya ha pagado una vez. Se valida contra el registro, no contra un rango.
    const requestedArena = body.arena === undefined ? ARENA_IDS.human : body.arena
    const arenaConfig = typeof requestedArena === 'number' && Number.isInteger(requestedArena) ? arenaById(requestedArena as ArenaId) : undefined
    if (!arenaConfig) return NextResponse.json({ error: 'INVALID_ARENA', requestId }, { status: 400 })
    const epoch = BigInt(body.epoch)
    if (epoch <= BigInt(0) || epoch > BigInt(10_000_000)) return NextResponse.json({ error: 'INVALID_EPOCH', requestId }, { status: 400 })
    const result = await publishVyrEpoch(epoch, arenaConfig.id, requestId)
    return NextResponse.json({ ...result, requestId }, { status: 200 })
  } catch (error) {
    const known = ['EPOCH_NOT_CLOSED', 'NO_RECORDED_SCORES', 'PUBLISH_ALREADY_IN_PROGRESS', 'DISTRIBUTION_SNAPSHOT_MISSING', 'DISTRIBUTION_SNAPSHOT_MISMATCH']
    const code = error instanceof Error && known.includes(error.message) ? error.message : 'PUBLISH_FAILED'
    const status = code === 'EPOCH_NOT_CLOSED' || code === 'PUBLISH_ALREADY_IN_PROGRESS' ? 409 : code === 'NO_RECORDED_SCORES' ? 422 : 503
    console.error(JSON.stringify({ event: 'vyr_publish_failed', requestId, errorCode: code }))
    return NextResponse.json({ error: code, requestId }, { status })
  }
}
