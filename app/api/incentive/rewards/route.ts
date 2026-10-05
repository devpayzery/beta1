import { NextResponse } from 'next/server'
import { apiError } from '@/lib/arcade-types'
import { consumeLimit, rateLimitResponse, requestIp } from '@/lib/rate-limit'
import { requireWalletSession } from '@/lib/wallet-auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { logOperationalError } from '@/lib/server-log'
import { resolveArenaParam } from '@/lib/arcade-arenas'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  // FINDING (medium, remediated): this route had no rate limiting whatsoever.
  let ipLimit
  try { ipLimit = await consumeLimit('incentive_rewards_ip', requestIp(request)) } catch (error) {
    logOperationalError('incentive.rewards.rate_limit', requestId, error)
    return apiError('CHAIN_UNAVAILABLE', 'Request controls are unavailable.', 503, requestId)
  }
  if (!ipLimit.allowed) return rateLimitResponse(requestId, ipLimit.retryAfter)

  // FINDING (critical, remediated): `?wallet=` was self-asserted and read via the service-role
  // client, exposing any address's claim history.
  const session = requireWalletSession(request, new URL(request.url).searchParams.get('wallet'))
  if ('error' in session) return session.error

// FINDING (critical, Etapa 4): las dos consultas de abajo llevaban `.eq('arena_type', 'human')`
  // fijo. La ruta no leia `?arena=` en absoluto, asi que pedia medium y recibia los reclamos y las
  // partidas de human: el jugador veia su historial del modo equivocado y el boton de reclamar
  // firmaba `claimPrize` con el id de medium sobre una fila que era de human. Cuatro literales de
  // este tipo persiguieron la app durante toda la migracion a V6 (`verifyScoreRecorded` x2,
  // `claimPrize` y estos dos) y ninguno lo atrapo un grep por `ARENA_IDS.human`: aqui el literal es
  // `'human'` dentro de un `.eq()`, no el simbolo del registro. El barrido que de verdad sirve
  // busca cualquier comparacion contra un nombre de modo, no un identificador concreto.
  //
  // A diferencia de /api/play, aqui AUSENTE cae a human pero PRESENTE-E-INVALIDO se rechaza, en
  // vez de caer tambien. En /api/play la caida es inevitable: el 402 tiene que anunciar el precio
  // del modo pedido y sin parametro no hay modo que anunciar. Aqui no hay importe de por medio, y
  // un `?arena=inventado` que cayera a human devolveria una lista coherente y equivocada, que es
  // la peor forma de fallar: el jugador no ve ningun sintoma. `resolveArenaParam` decide esa
  // distincion; aqui solo se aplica.
  //
  // `resolved.fromDefault` distingue "el cliente no mando modo" de "mando este modo". No se registra
  // porque no es una condicion anomala y pasaria por el log en cada llamada antigua, que es como
  // se enseñan a ignorar los logs. Queda disponible para quien necesite distinguirlo.
  const resolved = resolveArenaParam(new URL(request.url).searchParams.get('arena'))
  if (!resolved.ok) return apiError('INVALID_JSON', 'The requested arena is not available.', 400, requestId)
  const arenaType = resolved.arena.type

  const db = createAdminClient()
  const [claims, entries] = await Promise.all([
    // vyr_claims_wei, not vyr_claims: `amount` is numeric(78,0) and PostgREST would serialise it as
    // a JSON number, silently rounding anything above 2^53. The view casts it to text.
    db.from('vyr_claims_wei').select('epoch,arena_type,amount,status,tx_hash,confirmed_at').eq('arena_type', arenaType).eq('wallet', session.wallet).order('epoch', { ascending: false }).limit(100),
    db.from('arcade_scores_best').select('epoch,arena_type,score,tx_hash,created_at').eq('arena_type', arenaType).eq('wallet', session.wallet).order('created_at', { ascending: false }).limit(100),
  ])
  if (claims.error || entries.error) return NextResponse.json({ error: 'REWARDS_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } })
  return NextResponse.json({
    // El modo viaja en la respuesta para que el filtro sea observable desde el cliente. Sin el, un
    // fallo de este filtro es indistinguible de "este wallet no tiene nada en este modo".
    arena: arenaType,
    rewards: (claims.data ?? []).map((claim) => ({ kind: 'vyr', epoch: String(claim.epoch), amount: String(claim.amount), status: claim.status, txHash: claim.tx_hash, confirmedAt: claim.confirmed_at })),
    entries: (entries.data ?? []).map((entry) => ({ epoch: String(entry.epoch), score: entry.score, txHash: entry.tx_hash, createdAt: entry.created_at })),
  }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } })
}
