import { keccak256, stringToHex, type Hex } from 'viem'
import type { GameResult, GameplayEvent } from './arcade-types'
import { arenaByType, type ArenaConfig, type ArenaType, type GameplayRules, type ScoringRules, type ShieldRules } from './arcade-arenas'

/**
 * Las reglas de validacion de una partida salen del REGISTRO de arenas (`lib/arcade-arenas.ts`),
 * no de constantes aqui. Estas constantes se conservan porque son los valores de la arena `human`
 * y asi lo verifican `tests/arcade-arenas.test.ts`: si el registro cambia human, este fichero
 * tiene que fallar el test en vez de seguir validando con los numeros viejos.
 *
 * Antes de V6 no habia decision que tomar: solo existia una arena. Con tres modos, cada uno con
 * ventana de tiempo, intervalo minimo y tolerancia propios, validar siempre contra los numeros de
 * human acceptaria en `hard` una partida con 20 eventos separados por 60ms, cuando `hard` exige 50.
 * Eso es el mismo tipo de fallo que `REQUIRED_PAYMENT_AMOUNT` valido a 0.1 para toda la app.
 */
export const MAX_DURATION_MS = 30_000
export const MAX_EVENTS = 60
export const MAX_SCORE = MAX_EVENTS * 400

/**
 * Minimum wall-clock separation between two recorded hits.
 *
 * FINDING (critical, remediated): event `atMs` values were entirely client-controlled and only
 * range-checked, so 60 identical events at `atMs: 0` produced exactly MAX_SCORE in a single
 * request. Requiring a strictly increasing, minimally spaced sequence makes the per-event time
 * decay term meaningful and caps how much of the score can be claimed in the first second.
 *
 * 60ms sits below the fastest sustained human click cadence (browser double-click latency is
 * ~100-150ms), so a legitimate player is never rejected. The client applies the same floor in
 * hitTarget so the on-screen score always equals the score the server recomputes.
 *
 * ATENCION: es el valor de `human`. Para validar otra arena se usa `gameplay.minEventIntervalMs`
 * del registro.
 */
export const MIN_EVENT_INTERVAL_MS = 60

/**
 * Half-width of the box, in the 0..100 game coordinate space, within which a recorded hit must
 * land relative to the target position the server derives from `gameSeed`.
 *
 * FINDING (critical, remediated): the client used `Math.random()` for target placement, so the
 * server had nothing to check a hit against. `gameSeed` was already generated and returned to
 * the client but never consumed. Deriving the target sequence server-side from the seed turns the
 * event stream into something checkable: a forged constant position no longer matches the
 * expected sequence.
 *
 * This raises the cost of forging. It is NOT cryptographic proof of gameplay, because `gameSeed`
 * is transmitted to the client and a determined attacker can recompute the same sequence. See
 * docs/ArcadeVault-audit.md and docs/v3-contract-audit-status.md for the accepted-risk framing.
 *
 * ATENCION: es el valor de `human`. Para validar otra arena se usa `gameplay.targetTolerance`.
 */
export const TARGET_TOLERANCE = 6

/**
 * Resolves the rules to validate against.
 *
 * `arena` is REQUIRED rather than optional. Making it optional is what let V5 callers pass `seed`
 * alone and get human's numbers for a score that was about to be signed for another arena; the
 * `?? HUMAN` branch is exactly the silent-wrong-arena defect the arena migration exists to remove.
 * Both callers in this repo can supply the arena: the finish route has the session, and the tests
 * pass the arena they mean.
 */
function resolveRules(arena: ArenaConfig | ArenaType): GameplayRules {
  const config = typeof arena === 'string' ? arenaByType(arena) : arena
  if (!config) throw new Error('ARENA_UNKNOWN')
  return config.gameplay
}

/**
 * Deterministic target centre for hit `index`, in the 0..100 game coordinate space.
 * Mirrors the derivation in app/play/page.tsx; both sides must agree exactly.
 */
export function expectedTarget(seed: Hex, index: number, range?: GameplayRules['targetRange']): { x: number; y: number } {
  const bounds = range ?? arenaByType('human')!.gameplay.targetRange
  const digest = keccak256(stringToHex(`${seed}:${index}`))
  // Use two independent byte windows of the digest for x and y.
  const xByte = Number.parseInt(digest.slice(2, 4), 16)
  const yByte = Number.parseInt(digest.slice(4, 6), 16)
  return {
    x: Math.round(bounds.minX + (xByte / 255) * (bounds.maxX - bounds.minX)),
    y: Math.round(bounds.minY + (yByte / 255) * (bounds.maxY - bounds.minY)),
  }
}

export function gameResultValidationError(value: unknown, seed: string | undefined, arena: ArenaConfig | ArenaType): string | null {
  if (!value || typeof value !== 'object') return 'shape'
  const rules = resolveRules(arena)
  const maxScore = maxScoreForRules(rules)
  const result = value as Record<string, unknown>
  const events = result.events
  const score = result.score
  const startedAt = result.startedAt
  const finishedAt = result.finishedAt
  // The score is compared against THIS arena's maximum, not a global maximum. The maximum
  // depends on the per-second bonus and the decay window, and both change per mode, so
  // a global maximum would be either too lax in hard or too strict in human.
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > maxScore) return 'score'
  if (typeof startedAt !== 'number' || !Number.isInteger(startedAt) || typeof finishedAt !== 'number' || !Number.isInteger(finishedAt)) return 'timestamps'
  if (!Array.isArray(events) || events.length > rules.maxEvents) return 'events'
  // 1s margin: client and server clocks don't match to the millisecond, and without the
  // margin a legitimate 30000ms round would be rejected for 1ms of drift.
  if (finishedAt < startedAt) return 'negative_duration'
  if (finishedAt - startedAt > rules.maxDurationMs + 1000) return 'duration_exceeded'
  if (!events.every((event) => {
    if (!event || typeof event !== 'object') return false
    const item = event as Record<string, unknown>
    const atMs = item.atMs
    return typeof atMs === 'number' && Number.isInteger(atMs) && typeof item.x === 'number' && typeof item.y === 'number' && atMs >= 0 && atMs <= rules.maxDurationMs && item.x >= 0 && item.x <= 100 && item.y >= 0 && item.y <= 100
  })) return 'event_shape'
  if (events.length > 1 && !hasPlausibleTimeline(events as GameplayEvent[], rules)) return 'implausible_timeline'
  // The shield activation flow is validated AGAINST ITS RULES, not after: if a miss
  // declared invalid activations, the rejection must come before the score is compared,
  // so the reason is the activation, not a 422 on score that the player can't interpret.
  const shieldError = shieldValidationError((result as { shieldActivations?: unknown }).shieldActivations, rules)
  if (shieldError) return shieldError
  if (seed !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(seed)) return 'invalid_seed'
    // FINDING (Stage 5): this was `if (!matchesSeedTargets(...)) return 'target_mismatch'`, y ya no
    // can no longer be a rejection. A miss is by definition off-target, so requiring
    // that EVERY event land on the target would forbid by rule exactly what the shield
    // mechanic just allowed. The check isn't dropped: it moves down to `classifyClicks`, inside
    // `expectedScore`, where it decides how much each click scores. What stopped the attacker declaring
    // MAX_SCORE con clics fuera de la diana sigue frenandolo, pero por la via correcta: el score
    // recomputed gives 0 and doesn't match the declared one. The test "an attacker clicking off-target
    // no longer gains points" pins exactly that, because a defense that must move site must never
    // be silently deleted.
  return null
}
  return null
}

/**
 * Hits must be strictly increasing in time and at least the arena's `minEventIntervalMs` apart.
 * Without this, a single request could claim every event at full value at t=0.
 */
export function hasPlausibleTimeline(events: readonly GameplayEvent[], rules: GameplayRules = arenaByType('human')!.gameplay): boolean {
  for (let index = 1; index < events.length; index += 1) {
    const delta = events[index]!.atMs - events[index - 1]!.atMs
    if (delta < rules.minEventIntervalMs) return false
  }
  return true
}

/**
 * Clasifica cada clic como ACIERTO o FALLO comparandolo con la diana que le toca por indice.
 *
 * El indice es el del CLIC, no el del acierto. Es la parte que no se puede relajar: si la diana del
 * clic `i` fuera "la siguiente diana no pulsada", un jugador podria saltarse las dianas que no le
 * interesan y declarar acierto solo en las que le convienen. Con el indice atado al clic, la
 * secuencia es la misma para todos y cada eslabon se acierta o se falla.
 *
 * Esto sustituye a la antigua validacion `target_mismatch`, que exigia que TODO evento cayese sobre
 * la diana. Con fallos permitidos esa comprobacion ya no puede ser una puerta de rechazo, porque un
 * fallo es por definicion estar fuera de la diana; pasa a ser una CLASIFICACION que decide cuanto
 * puntua cada clic. La defensa contra el score forjado no desaparece, se mueve: ahora la sostiene la
 * comparacion entre el score declarado y el recomputado, en app/api/play/finish. Es el cambio de
 * sitio en el que el test "un atacante que clica fuera de la diana ya no gana puntos" deja fijado.
 */
export function classifyClicks(events: readonly GameplayEvent[], seed: Hex, rules: GameplayRules): boolean[] {
  return events.map((event, index) => {
    const target = expectedTarget(seed, index, rules.targetRange)
    return Math.abs(event.x - target.x) <= rules.targetTolerance && Math.abs(event.y - target.y) <= rules.targetTolerance
  })
}

/**
 * Todos los clics fueron aciertos: partida perfecta. Se mantiene porque es la condicion que cumple
 * el cliente honesto y la que un atacante ya no puede fingir. Si clasifica mal, el score recomputado
 * no le cuadra con el que declara.
 */
export function matchesSeedTargets(events: readonly GameplayEvent[], seed: Hex, rules: GameplayRules = arenaByType('human')!.gameplay): boolean {
  return classifyClicks(events, seed, rules).every(Boolean)
}

/**
 * El escudo cubre el instante `atMs`?
 *
 * La ventana es [activacion, activacion + durationMs): cerrada por la izquierda y abierta por la
 * derecha. Un clic en el mismo milisegundo que la activacion ya esta cubierto; uno en el milisegundo
 * exacto de `activacion + durationMs` ya no. El borde importa para que dos activaciones seguidas no
 * se solapen por un milisegundo, que es lo que haria que el cooldown no cuadrase con la duracion.
 */
export function shieldActiveAt(activations: readonly number[], rules: ShieldRules, atMs: number): boolean {
  return activations.some((from) => atMs >= from && atMs < from + rules.durationMs)
}

/**
 * Valida el flujo de activaciones contra las reglas de la arena. Devuelve el motivo o `null`.
 *
 * Lo que se comprueba, y por que importa cada cosa:
 *
 *   - Que la arena TENGA escudo. En `human` no lo hay, y declarar activaciones describe una
 *     mecanica inexistente. No darian puntos (el calculo ignora un `shield` nulo), asi que el
 *     rechazo no protege el score: es para que un cliente que se crea con escudo en una arena sin
 *     escudo se entere, en vez de jugar 25s esperando una proteccion que nunca llega.
 *   - Cuantas. `maxActivations` es el tope por ronda. Sin el, un cliente declararia 60 activaciones
 *     y tendria la partida entera cubierta.
 *   - CUANDO. Cada activacion tiene que estar en `[0, cannotActivateAfterMs]`. Este es el que hace
 *     que `durationMs = cannotActivateAfterMs = 10s` signifique algo: activar en el ultimo segundo
 *     cubre un tramo que ya no puntuaba bonus, asi que es tiempo desperdiciado, y el jugador que
 *     lo hace lo pierde sin que el servidor tenga que avisarle de nada.
 *   - El cooldown entre activaciones. Con `maxActivations: 1` es vacuo hoy, pero se comprueba igual
 *     para que anadir una arena con varias activaciones no encuentre el fallo en produccion.
 */
export function shieldValidationError(value: unknown, rules: GameplayRules): string | null {
  // Absent reads as "I don't use it". A client from before the mechanic doesn't send the field, and
  // rejecting it would be a 422 on a legitimate human round: the failure indistinguishable from a
  // fraud attempt this repo has spent five stages removing. Absence is NEVER read
  // as a free shield, because not using it and it not existing give the same result.
  const activations = value === undefined || value === null ? [] : value
  if (!Array.isArray(activations)) return 'shield_shape'
  if (!activations.every((atMs) => typeof atMs === 'number' && Number.isInteger(atMs))) return 'shield_shape'
  const shield = rules.shield
  if (!shield) return activations.length > 0 ? 'shield_not_available' : null
  if (activations.length > shield.maxActivations) return 'shield_too_many'
  if (activations.length === 0) return null
  if (activations.some((atMs) => atMs < 0 || atMs > shield.cannotActivateAfterMs)) return 'shield_too_late'
  const sorted = [...activations].sort((a, b) => a - b)
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]! - sorted[index - 1]! < shield.cooldownMs) return 'shield_cooldown'
  }
  return null
}
export function isValidGameResult(value: unknown, seed: string | undefined, arena: ArenaConfig | ArenaType): value is GameResult {
  return gameResultValidationError(value, seed, arena) === null
}

/**
 * Valor de UN clic, o 0 si no puntuo. Esta es la unica copia de la formula de un clic.
 *
 * Se extrae como funcion propia, y no se deja escrita dentro de `expectedScore`, por un motivo que
 * solo aparece con los boosters: el score y el total de VYNAR se calculan por separado —el score va
 * a `recordScore` y el VYNAR a `mintForScoreOnce`, que son dos transacciones distintas— pero tienen
 * que partir del MISMO valor por clic. Con la formula duplicada, el dia que cambie el decaimiento o
 * el bonus se cambia en un solo sitio, el booster se queda multiplicando un numero que el score ya
 * no usa, y nada falla: el score sigue cuadrando y el VYNAR queda silenciosamente incorrecto. Es el
 * mismo modo de fallo que el de `expectedScore(validResult)` sin arena, que validaba contra un modo
 * y recomputaba contra otro.
 *
 * `scored` es la decision ya tomada —el clic acerto, o fallo con el escudo activo— y no el motivo
 * de esa decision. Quien llama es el unico que puede saberlo, porque solo el tiene el seed.
 */
export function clickValue(scoring: ScoringRules, event: Pick<GameplayEvent, 'atMs'>, scored: boolean): number {
  if (!scored) return 0
  return scoring.base + Math.max(0, scoring.decayWindowSeconds - Math.floor(event.atMs / 1000)) * scoring.bonusPerSecond
}

/**
 * Recomputes the score from the click stream using the arena's rules. ESTA is the only copy of the
 * formula: the server recomputes with it and the page displays with it, so they cannot drift.
 *
 * Two arguments are REQUIRED, and both exist because omitting one produced a silent wrong answer.
 *
 * `arena` REQUIRED, never optional with a `= 'human'` default. FINDING (critical, corregido): the
 * call in app/api/play/finish was `expectedScore(validResult)`, so a `hard` session recomputed with
 * human's `base 100, bonus 10, decay 30s` instead of `base 100, bonus 15, decay 15s`. The 422 the
 * player received was a number the server itself had invented, with no exception or log to tell it
 * apart from fraud. A default on a function whose only purpose is validating against the WRONG
 * arena is exactly the default to remove: being forced to pass it is what makes the omission
 * visible next time.
 *
 * `seed` REQUIRED for the same reason, and for a new one. Deciding whether a click scored needs the
 * seed-derived target, so without it there is nothing to recompute. Note what it is NOT allowed to
 * default to: a missing seed cannot mean "every click was a hit", because that would be the
 * maximum score. Both call sites have a real seed (the session always carries one), so requiring it
 * costs nothing and removes a maximum-score path.
 *
 * THE SHIELD. A click that misses scores 0: the penalty is losing the points that click would have
 * earned, not a fixed deduction. That is deliberate, and it is why no `missPenalty` constant exists
 * in the registry — inventing a number would have been a guess, and this reading needs none, since
 * it is fully determined by values that already exist. It also keeps the score from ever going
 * negative, so the `score >= 0` bound and `maxScoreForRules` stay exactly as they were.
 *
 * While the shield is active a click scores in full even if it missed: that is precisely what
 * "blocks the penalty" means, and it is the whole reason to spend the one activation.
 */
export function expectedScore(result: GameResult, seed: Hex, arena: ArenaConfig | ArenaType): number {
  const rules = resolveRules(arena)
  const { scoring, shield } = rules
  const hits = classifyClicks(result.events, seed, rules)
  // `?? []` because a client from before the mechanic doesn't send the field, and that means "I don't use it",
  // never "I use it for free". See `shieldValidationError`, which reasons the same way in the same place.
  const activations = result.shieldActivations ?? []
  // The "worth zero" of a miss and the "worth full" with active shield are NOT written here: they are decided
  // by `clickValue`, the only copy of the formula, and for the same reason it is shared with the total
  // VYNAR of boosters. Here we only answer the prior question: did this click score or not.
  return result.events.reduce((total, event, index) => {
    const scored = Boolean(hits[index]) || Boolean(shield && shieldActiveAt(activations, shield, event.atMs))
    return total + clickValue(scoring, event, scored)
  }, 0)
}

/** Max score for an arena's rules, derived rather than cabled. */
export function maxScoreForRules(rules: GameplayRules): number {
  return rules.maxEvents * (rules.scoring.base + rules.scoring.decayWindowSeconds * rules.scoring.bonusPerSecond)
}

/**
 * Exposed for diagnostics only; never log the seed itself.
 *
 * The seed IS the answer key for the target sequence, so it must never reach a log line: anyone
 * with the logs could recompute every target and forge a maximal run. The fingerprint is a short
 * digest so two sessions can be correlated in a bug report without disclosing either seed.
 */
export function seedFingerprint(seed: Hex): string {
  return keccak256(stringToHex(`fingerprint:${seed}`)).slice(0, 18)
}
