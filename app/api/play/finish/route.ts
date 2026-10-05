import { NextResponse } from 'next/server'
import { isAddress, type Address } from 'viem'
import { createAdminClient } from '@/lib/supabase/admin'
import { apiError, type GameResult } from '@/lib/arcade-types'
import { getSession, transitionSession } from '@/lib/session-store'
import { isSessionUsed, MintPendingError, recoverScoreMint, submitScoreFromServer, verifyScoreRecorded, waitForConfirmation } from '@/lib/server-blockchain'
import { consumeLimit, rateLimitResponse, requestIp } from '@/lib/rate-limit'
import { expectedScore, gameResultValidationError } from '@/lib/score-validation'
import { boosterValidationError, expectedVynarPoints, vynarPointsRangeError } from '@/lib/booster-validation'
import { availableBoosterUnits, consumeBoosterUnit } from '@/lib/booster-store'
import { arenaByType, asVynarPoints } from '@/lib/arcade-arenas'
import { persistedScoreTransition } from '@/lib/submission-policy'
import { getServerEnv } from '@/lib/server-env'
import { logOperationalError } from '@/lib/server-log'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const requestId = crypto.randomUUID()
  let ipLimit
  try { ipLimit = await consumeLimit('finish_ip', requestIp(request)) } catch { return apiError('CHAIN_UNAVAILABLE', 'Request controls are unavailable.', 503, requestId) }
  if (!ipLimit.allowed) return rateLimitResponse(requestId, ipLimit.retryAfter)
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return apiError('INVALID_JSON', 'Content-Type debe ser application/json.', 415, requestId)
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > 32_768) return apiError('INVALID_SCORE', 'El payload es demasiado grande.', 413, requestId)
  try {
    const body = await request.json() as Record<string, unknown>; const sessionId = body.sessionId; const wallet = body.wallet; const result = body.result
    // FINDING (critical, remediated): shape validation no longer runs here. It has to run after the
    // session is loaded, because replaying the seed-derived target sequence is part of validation
    // and the seed is server-held session state. Validating first would let a forger probe the
    // endpoint without ever proving ownership of the session.
    if (typeof sessionId !== 'string' || sessionId.length < 10 || typeof wallet !== 'string' || !isAddress(wallet) || !result || typeof result !== 'object') {
      console.error(JSON.stringify({ event: 'play.finish.invalid_result', requestId, sessionId: typeof sessionId === 'string' ? sessionId.slice(0, 18) : undefined, errorCode: 'INVALID_SCORE', validationReason: 'identity' }))
      return apiError('INVALID_SCORE', 'The game result is invalid.', 422, requestId)
    }
    const sessionLimit = await consumeLimit('finish_session', sessionId)
    if (!sessionLimit.allowed) return rateLimitResponse(requestId, sessionLimit.retryAfter)
    const walletLimit = await consumeLimit('finish_wallet', wallet.toLowerCase())
    if (!walletLimit.allowed) return rateLimitResponse(requestId, walletLimit.retryAfter)
    const session = await getSession(sessionId)
    if (!session) return apiError('SESSION_NOT_FOUND', 'The session does not exist.', 404, requestId)
    if (session.wallet.toLowerCase() !== wallet.toLowerCase()) return apiError('INVALID_SCORE', 'The wallet does not match the session.', 403, requestId)
    // El modo sale de la SESION, nunca del cuerpo de la peticion. La sesion lo tiene atado al pago
    // por el trigger arcade_sessions_arena_matches_payment, asi que es la unica fuente que no se
    // puede negociar desde el cliente. Aceptarlo aqui daria al jugador la eleccion de en que modo se
    // valida su partida, y con las tolerancias distintas por modo eso incluye elegir el human.
    const arenaConfig = arenaByType(session.arena)
    if (!arenaConfig) return apiError('INVALID_SCORE', 'The session refers to an unknown arena.', 422, requestId)
    const resultValidationError = gameResultValidationError(result, session.gameSeed, arenaConfig)
    if (resultValidationError) {
      console.error(JSON.stringify({ event: 'play.finish.invalid_result', requestId, sessionId: sessionId.slice(0, 18), errorCode: 'INVALID_SCORE', validationReason: resultValidationError, eventCount: result && typeof result === 'object' && 'events' in result && Array.isArray(result.events) ? result.events.length : undefined, firstEventAtMs: result && typeof result === 'object' && 'events' in result && Array.isArray(result.events) && result.events[0] && typeof result.events[0] === 'object' && 'atMs' in result.events[0] ? result.events[0].atMs : undefined, lastEventAtMs: result && typeof result === 'object' && 'events' in result && Array.isArray(result.events) && result.events.at(-1) && typeof result.events.at(-1) === 'object' && 'atMs' in result.events.at(-1) ? result.events.at(-1).atMs : undefined, serverTime: new Date().toISOString() }))
      return apiError('INVALID_SCORE', 'The game result is invalid.', 422, requestId)
    }
    const db = createAdminClient()
    const sessionBytes32 = session.sessionId as `0x${string}`
    if (session.status === 'submitting') {
      const pending = await db.from('arcade_scores').select('id,score,vynar_points,tx_hash,mint_tx_hash,mint_status,status').eq('session_id', sessionId).maybeSingle()
      if (pending.error) throw pending.error
      if (!pending.data) return apiError('SESSION_CONFLICT', 'The submission is pending reconciliation.', 409, requestId)
      if (pending.data.status === 'pending_mint' && pending.data.tx_hash) {
        try {
          // `pending.data.vynar_points`, no `pending.data.score`. Es la distincion que hace que un booster no
// se pierda al recuperar un mint a medias. Si aqui se pasara el score, la recuperacion mintearia
// el total sin booster de una partida que si lo declaro, y como `mintForScoreOnce` es de un solo
// disparo por sessionId, el jugador se quedaria sin la parte del 2x sin ningun error que lo dijera.
// `asVynarPoints` es el unico `as` de VYNAR del repo, y esta aqui porque la fila de la base es la
// frontera de confianza: la columna se grabo con `expectedVynarPoints` y el trigger la hace
// inmutable, asi que volver a marcarla no inventa nada, solo recupera el tipo nominal que se perdio
// al salir de PostgREST. Si algum dia alguien pasa `pending.data.score` aqui en su lugar, `tsc` lo
// rechaza en vez de dejar que una partida con booster mintee el total sin el 2x.
const recovered = await recoverScoreMint({ player: session.wallet as Address, vynarPoints: asVynarPoints(pending.data.vynar_points), sessionId: sessionBytes32, scoreHash: pending.data.tx_hash as `0x${string}` }, requestId)
          // tx_hash is carried forward explicitly: the arcade_scores_recorded_requires_tx CHECK rejects any
          // transition to 'recorded' without on-chain proof, and the recovery path previously relied on
          // tx_hash having been written by the original submit.
          const updated = await db.from('arcade_scores').update({ status: 'recorded', tx_hash: pending.data.tx_hash, mint_status: 'confirmed', mint_tx_hash: recovered.mintHash, confirmed_at: new Date().toISOString() }).eq('id', pending.data.id).eq('status', 'pending_mint').select('id').single()
          if (updated.error) throw updated.error
          await transitionSession(sessionId, 'submitting', 'recorded', { score_tx_hash: pending.data.tx_hash, mint_tx_hash: recovered.mintHash })
          return NextResponse.json({ status: 'confirmed', txHash: pending.data.tx_hash, mintTxHash: recovered.mintHash, requestId })
        } catch { return NextResponse.json({ status: 'pending_mint', scoreTxHash: pending.data.tx_hash, requestId }, { status: 202 }) }
      }
      const persistedTransition = persistedScoreTransition(pending.data.status as 'submitting' | 'recorded' | 'pending_mint' | 'failed')
      if (persistedTransition === 'recorded') {
        await transitionSession(sessionId, 'submitting', 'recorded', { score_tx_hash: pending.data.tx_hash ?? undefined })
        return NextResponse.json({ status: 'confirmed', txHash: pending.data.tx_hash, requestId })
      }
      if (persistedTransition === 'failed') {
        await transitionSession(sessionId, 'submitting', 'failed')
        return apiError('CHAIN_UNAVAILABLE', 'The score transaction failed.', 503, requestId)
      }
      if (!pending.data.tx_hash) {
        const used = await isSessionUsed(sessionBytes32)
        return apiError('SESSION_CONFLICT', used ? 'The session was consumed on-chain but cannot be reconciled without its transaction hash.' : 'The transaction is awaiting confirmation.', 409, requestId)
      }
      try {
        const receipt = await waitForConfirmation(pending.data.tx_hash as `0x${string}`)
        if (receipt.status !== 'success') {
          await db.from('arcade_scores').update({ status: 'failed', failed_at: new Date().toISOString(), error_code: 'CHAIN_TX_FAILED' }).eq('id', pending.data.id).eq('status', 'submitting')
          await transitionSession(sessionId, 'submitting', 'failed', { error_code: 'CHAIN_TX_FAILED' })
          return apiError('CHAIN_UNAVAILABLE', 'The score transaction failed.', 503, requestId)
        }
        // FINDING (critical, esta migracion): el `arena` iba HARDCODEADO a 0. Es el camino de
        // recuperacion: entra cuando la sesion quedo en `submitting` y hay que reconciliar un mint
        // a medias, o sea cuando la app mas la ha wichtig. Con `arena: 0` una sesion de `hard` se
        // verificaba contra el id de `human`, asi que o el mint legitimate no se reconocia y la
        // sesion se quedaba bloqueada, o se confirmaba un score contra una arena que no era la suya.
        // El id sale de la SESION, que es lo unico que el cliente no controla.
        verifyScoreRecorded(receipt, { player: session.wallet as Address, arena: arenaConfig.id, epoch: session.epoch, score: pending.data.score, sessionId: sessionBytes32 })
        const confirmed = await db.from('arcade_scores').update({ status: 'recorded', tx_hash: pending.data.tx_hash, confirmed_at: new Date().toISOString() }).eq('id', pending.data.id).eq('status', 'submitting').select('id').maybeSingle()
        if (confirmed.error || !confirmed.data) throw new Error('SCORE_CONFIRMATION_PERSISTENCE_FAILED')
        await transitionSession(sessionId, 'submitting', 'recorded', { score_tx_hash: pending.data.tx_hash })
        return NextResponse.json({ status: 'confirmed', txHash: pending.data.tx_hash, requestId })
      } catch {
        return apiError('CHAIN_UNAVAILABLE', 'The transaction is still awaiting confirmation.', 503, requestId)
      }
    }
    const now = Date.now()
    const expiresAtMs = Date.parse(session.expiresAt)
    if (expiresAtMs <= now) {
      console.error(JSON.stringify({ event: 'play.finish.session_expired', requestId, sessionId: sessionId.slice(0, 18), errorCode: 'SESSION_EXPIRED', sessionState: session.status, expiresAt: session.expiresAt, serverTime: new Date(now).toISOString(), remainingTtlMs: expiresAtMs - now }))
      await transitionSession(sessionId, session.status, 'expired')
      return apiError('SESSION_EXPIRED', 'The session has expired.', 409, requestId)
    }
// El score se RECOMPUTA con las reglas de la arena de la sesion. FINDING (critical, esta
    // migracion): la llamada era `expectedScore(validResult)` sin arena, asi que usaba el valor por
    // defecto, `human`. Dos lineas mas arriba la validacion de forma SI recibia `arenaConfig`, asi
    // que dentro de la misma funcion se validaba contra un modo y se recomputaba contra otro.
    // Las reglas no coinciden: human puntua base 100 con bonus 10 durante 30s, hard base 100 con
    // bonus 15 durante 15s. Un jugador de `hard` que hiciera una partida legitima de 20s
    // declaraba un score que el servidor recalculaba con la formula de human, y el 422 de la linea
    // siguiente le rechazaba por un numero que el propio servidor habia inventado.
    //
    // El tercer argumento es el `gameSeed`, y es el que hace que el recomputado sepa distinguir un
    // acierto de un fallo. Sin el, `expectedScore` solo podria sumar la formula a todos los clics,
    // que es exactamente el exploit de la auditoria: 60 clics declarados y 60 puntos. Con el, cada
    // clic se compara con la diana que le toca por indice y un fallo vale cero.
    //
    // Esta linea es ademas la que hoy frena al atacante que declara MAX_SCORE con clics fuera de la
    // diana. Antes lo frenaba `target_mismatch`, que dejo de existir al permitir fallos (un fallo ES
    // estar fuera de la diana). El razonamiento esta en lib/score-validation.ts y el test que lo
    // fija es "un atacante que clica fuera de la diana ya no gana puntos" en tests/arcade.test.ts.
    const validResult = result as GameResult
    const claimedScore = validResult.score; const expected = expectedScore(validResult, session.gameSeed, arenaConfig)
    if (claimedScore !== expected) return apiError('INVALID_SCORE', 'The score does not match the gameplay evidence.', 422, requestId)
    // EL BOOSTER NO ENTRA EN EL SCORE. El total de VYNAR se recalcula aparte, con las MISMAS reglas y
    // el mismo seed, y solo por la ventana de 10s de cada activacion declarada. Lo que se compara
    // arriba —`claimedScore !== expected`— sigue sin saber que existen boosters, y esa es la razon
    // de que un booster no pueda mover un puesto del leaderboard: no es que se descuente luego, es
    // que la columna del ranking no pasa por aqui.
    //
    // El orden importa y no es estetico: el consumo de la unidad va DESPUES de que el score cuadra.
    // Si un cliente declarase una activacion de booster en una partida invalida, todavia no se ha
    // gastado nada. Al reves, un 422 de score con la unidad ya consumida seria un booster quemado
    // por un fraude ajeno, que es exactamente el tipo de perdida que este repo lleva cinco etapas
    // evitando en la otra punta (el 422 de `human` recalculado como `hard`).
    const vynarError = boosterValidationError(validResult.boosterActivations, arenaConfig.gameplay, await availableBoosterUnits(session.wallet as Address, arenaConfig.id))
    if (vynarError) {
      console.error(JSON.stringify({ event: 'play.finish.invalid_booster', requestId, sessionId: sessionId.slice(0, 18), errorCode: 'INVALID_SCORE', validationReason: vynarError, arena: session.arena, boosterActivations: Array.isArray(validResult.boosterActivations) ? validResult.boosterActivations.length : undefined }))
      return apiError('INVALID_SCORE', 'The game result is invalid.', 422, requestId)
    }
    const vynarPoints = expectedVynarPoints(validResult, session.gameSeed, arenaConfig)
    // El techo se comprueba aunque `expectedVynarPoints` no pueda pasarse: la funcion es la que sabe
    // leer el registro, y una ruta que la importara y se olvidara de esta linea no fallaria en
    // compilacion. El rango se cierra aqui para que la columna de la BD solo reciba valores validos.
    const vynarRangeError = vynarPointsRangeError(vynarPoints, arenaConfig.gameplay, claimedScore)
    if (vynarRangeError) return apiError('INVALID_SCORE', 'The game result is invalid.', 422, requestId)
    if (!(await transitionSession(sessionId, 'active', 'submitting'))) return apiError('PAYMENT_REPLAY', 'The session was already submitted or is not active.', 409, requestId)
    // La unidad se gasta con un CAS sobre `status = 'available'`, aqui y no antes, y solo si la
    // partida declaro alguna activacion. Que la fila se actualice una sola vez es lo que impide
    // que dos Finish concurrentes gasten la misma unidad: el segundo hace match de 0 filas y falla.
    const unitsUsed = validResult.boosterActivations?.length ?? 0
    if (unitsUsed > 0 && !(await consumeBoosterUnit(session.wallet as Address, arenaConfig.id, unitsUsed))) return apiError('BOOSTER_UNAVAILABLE', 'No booster units available for this round.', 409, requestId)
    // arena_type is written explicitly because the arcade_scores -> arcade_sessions binding trigger
    // requires the score row to match its session on wallet, epoch AND arena. Omitting it left the
    // column to its 'human' default, which happened to agree only by coincidence.
    // `vynar_points` se escribe en el INSERT y no en un UPDATE posterior. Es la unica occasion en que
// se calcula, y el trigger de inmutabilidad lo bloquea para siempre a partir de aqui: por eso
// `recoverScoreMint` lee ESTA columna en vez de recalcular. Sin ella, un mint a medias que se
// reintentara con reglas distintas mintearia un numero que no corresponde a la partida grabada.
const submission = await db.from('arcade_scores').insert({ session_id: sessionId, wallet: session.wallet, epoch: session.epoch.toString(), arena_type: session.arena, score: claimedScore, vynar_points: vynarPoints, status: 'submitting', gameplay: validResult }).select('id').single()
    if (submission.error) { await transitionSession(sessionId, 'submitting', 'failed', { error_code: 'SCORE_PERSISTENCE_FAILED' }); throw submission.error }
    try {
      // `claimedScore` y `vynarPoints` van como argumentos DISTINTOS y en ese orden. El score es el que
// decide el puesto en el leaderboard; el total de VYNAR es el que entra en la cartera. Pasar el
// score en los dos sitios seria el bug del booster: la partida puntuaria el doble de lo que vale.
const submitted = await submitScoreFromServer({ player: session.wallet as Address, score: claimedScore, vynarPoints, sessionId: sessionBytes32, epoch: session.epoch, arenaId: arenaConfig.id }, requestId)
      const confirmed = await db.from('arcade_scores').update({ status: 'recorded', tx_hash: submitted.scoreHash, chain_id: getServerEnv().chainId, submitted_at: new Date().toISOString(), confirmed_at: new Date().toISOString() }).eq('id', submission.data.id).eq('status', 'submitting').select('id').single()
      if (confirmed.error) throw confirmed.error
      await transitionSession(sessionId, 'submitting', 'recorded', { score_tx_hash: submitted.scoreHash, score: claimedScore })
      return NextResponse.json({ status: 'confirmed', txHash: submitted.scoreHash, mintTxHash: submitted.mintHash, requestId })
    } catch (error) {
      if (error instanceof MintPendingError) {
        await db.from('arcade_scores').update({ status: 'pending_mint', tx_hash: error.scoreHash, submitted_at: new Date().toISOString(), error_code: 'PENDING_MINT' }).eq('id', submission.data.id).eq('status', 'submitting')
        return NextResponse.json({ status: 'pending_mint', scoreTxHash: error.scoreHash, requestId }, { status: 202 })
      }
      await transitionSession(sessionId, 'submitting', 'failed', { error_code: 'SCORE_SUBMISSION_FAILED' })
      return apiError('CHAIN_UNAVAILABLE', 'The score could not be submitted by the game server.', 503, requestId)
    }
  // FINDING (medium, remediated): this bare `catch {}` returned a generic 500 while discarding the
  // actual error, which is why the mint_tx_hash 42703 failure could strand a session in
  // `submitting` with nobody able to see why. logOperationalError records the requestId so the
  // cause is recoverable from the logs.
  } catch (error) { logOperationalError('play.finish.unhandled', requestId, error); return apiError('INTERNAL_ERROR', 'We could not record the score.', 500, requestId) }
}
