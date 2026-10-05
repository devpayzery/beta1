import type { Hex } from 'viem'
import type { GameResult } from './arcade-types'
import { arenaByType, asVynarPoints, type ArenaConfig, type ArenaType, type BoosterRules, type GameplayRules, type VynarPoints } from './arcade-arenas'
import { classifyClicks, clickValue, shieldActiveAt } from './score-validation'

/**
 * Modulo puro: sin `server-only`, sin env, sin DB, para que vitest pueda importarlo. Reglas de
 * boosters. Sin este modulo no habria forma de testear el 2x sin levantar Postgres y viem.
 */

/**
 * QUE MULTIPLICA UN BOOSTER, Y POR QUE NO PUEDE TOCAR EL SCORE
 *
 * `multiplierBps` es el multiplicador del VYNAR y de nada mas. El camino del VYNAR y el del score
 * son transacciones distintas:
 *
 *     recordScore(...)      -> score        -> arcade_scores.score -> leaderboard, premios, rangos
 *     mintForScoreOnce(...) -> vynarPoints  -> VYNAR al jugador
 *
 * El score se manda en el primer argumento, uno, sin multiplicador posible: `recordScore` no recibe
 * ningun factor y el vault no sabe que existen boosters. La unica forma de que un 2x tocara los
 * puntos seria reescribir `arcade_scores.score` con el valor duplicado, y eso no se hace porque la
 * columna se valida contra `expectedScore`, que no sabe de boosters. La separacion es estructural:
 * no depende de que alguien recuerde no multiplicar.
 *
 * El numero que sale de aqui, `expectedVynarPoints`, es lo que se pasa a `mintForScoreOnce` COMO
 * `points`. Ojo al nombre del parametro del token: tambien se llama `points`, y no es el score. Son
 * dos magnitudes distintas que el token no distingue, y por eso el orden en el que se calculan
 * importa tanto.
 *
 * LA VENTANA DE 10 SEGUNDOS
 *
 * `durationMs` son 10s. El 2x cubre solo los clics dentro de [activacion, activacion + 10s), y el
 * resto de la partida va a 1x. Es lo que significa "el 2x dura 10 segundos" en un sistema donde el
 * VYNAR se mintea de una vez al final: si el 2x se aplicara a la partida entera, no habria ninguna
 * ventana que acotar, y lo que se habria pedido seria el plazo para activar, no la duracion del
 * efecto.
 *
 * Que el minte sea UN DISPARO por `rewardId` (el sessionId) es lo que hace esto necesario y no
 * opcional: si el VYNAR se ganara por segundo, la ventana se implementaria sola. Al mintearse de
 * una vez, el unico modo de que una ventana de 10s signifique algo es ponderar los clics, asi que
 * la duracion vive en `boosterActiveAt` y en ningun otro sitio.
 *
 * LA VENTANA NO SE ACUMULA. Un clic dentro de dos ventanas cuenta 2x, no 4x, porque la pregunta es
 * binaria: "esta dentro de alguna ventana". Con `maxActivations: 1` no puede solaparse nada hoy, pero
 * la asercion esta porque si manana se sube a 2 activaciones el 4x tiene que seguir siendo
 * imposible, y es mejor que lo decida esta linea y no un test escrito despues.
 */

/** Divide por bps con suelo, nunca redondeando al alza: un suelo reparte el redondeo a favor del vault, y el redondeo al alza seria over-mint. */
function applyBps(value: number, bps: number): number {
  return Math.floor((value * bps) / 10_000)
}

/** Maximo absoluto de VYNAR-puntos para unas reglas, derivado y no cableado. Multiplica el maximo de score por el multiplicador. */
export function maxVynarPointsFor(rules: GameplayRules): number {
  const booster = rules.booster
  if (!booster) return rules.maxEvents * (rules.scoring.base + rules.scoring.decayWindowSeconds * rules.scoring.bonusPerSecond)
  const maxClick = rules.scoring.base + rules.scoring.decayWindowSeconds * rules.scoring.bonusPerSecond
  return applyBps(rules.maxEvents * maxClick, booster.multiplierBps)
}

/**
 * El 2x cubre el instante `atMs`?
 *
 * La ventana es [activacion, activacion + durationMs): cerrada por la izquierda, abierta por la
 * derecha. Es el mismo criterio que `shieldActiveAt`, y por el mismo motivo: un clic en el
 * milisegundo de la activacion ya esta dentro, y uno en el milisegundo exacto de
 * `activacion + durationMs` ya no. Con duracion 10s son los clics de 0 a 9.999s.
 *
 * Ojo al final del rango: el ultimo instante de una ventana es `activation + durationMs - 1`, que
 * con 10s son los 9.999s. Un clic de 10.000s queda FUERA, y es intencionado: si el borde fuera
 * cerrado, dos activaciones separadas justo por la duracion se solaparian en un milisegundo y el
 * cooldown dejaria de cuadrar con la duracion.
 */
export function boosterActiveAt(activations: readonly number[], rules: BoosterRules, atMs: number): boolean {
  return activations.some((from) => atMs >= from && atMs < from + rules.durationMs)
}

/**
 * Valida el flujo de activaciones contra las reglas de la arena y contra las unidades pagadas.
 * Devuelve el motivo o `null`.
 *
 * Lo que se comprueba, y por que importa cada cosa:
 *
 *   - Que la arena TENGA booster. Una arena sin booster no admite activaciones. Igual que con el
 *     escudo, declararlas no daria VYNAR (el calculo ignora un `booster` nulo) asi que el rechazo no
 *     protege el dinero: es para que un cliente que se inventa la mecanica se entere en vez de
 *     jugar 25s esperando un 2x que nunca llega.
 *   - Cuantas. `maxActivations` por ronda, y ademas no mas de las unidades que el jugador ha
 *     pagado. Las dos cosas: `maxActivations` es el tope de la arena, `availableUnits` es el
 *     derecho Economico. Sin el segundo, declararias 60 activaciones y el 2x saldaria gratis.
 *   - CUANDO. Cada activacion tiene que caer dentro de la ronda, `[0, maxDurationMs]`. A diferencia
 *     del escudo no hay `cannotActivateAfterMs`: el booster se paga, y prohibir cuando se puede
 *     usar solo castiga a quien pago. El tope superior sale de `maxDurationMs`, que ademas el
 *     `event_shape` ya garantiza para los clics.
 *   - El cooldown. Vacio con `maxActivations: 1`, se comprueba igual por si manana hay varias
 *     activaciones por partida.
 */
export function boosterValidationError(value: unknown, rules: GameplayRules, availableUnits: number): string | null {
  // Absent reads as "I don't use it", never as "one free". A client that doesn't know the booster
  // doesn't send the field, and rejecting it would be a 422 on a legitimate round: the same failure
  // indistinguishable from a fraud attempt this repo has spent five stages removing. The absence
  // is never read as a free booster, because not using it and it not existing give the same result.
  const activations = value === undefined || value === null ? [] : value
  if (!Array.isArray(activations)) return 'booster_shape'
  if (!activations.every((atMs) => typeof atMs === 'number' && Number.isInteger(atMs))) return 'booster_shape'
  const booster = rules.booster
  if (!booster) return activations.length > 0 ? 'booster_not_available' : null
  if (activations.length > booster.maxActivations) return 'booster_too_many'
  if (activations.length > availableUnits) return 'booster_no_units'
  if (activations.length === 0) return null
  if (activations.some((atMs) => atMs < 0 || atMs > rules.maxDurationMs)) return 'booster_out_of_round'
  const sorted = [...activations].sort((a, b) => a - b)
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]! - sorted[index - 1]! < booster.cooldownMs) return 'booster_cooldown'
  }
  return null
}

/**
 * Recalcula el total de VYNAR-puntos de una partida, aplicando el 2x a los clics que caen dentro de
 * la ventana de cada activacion.
 *
 * NO es `expectedScore`, y no lo es a proposito: son dos magnitudes que viajan en transacciones
 * distintas. El score va entero a `recordScore` y decide rankings y premios; este total va a
 * `mintForScoreOnce` y decide quantos VYNAR entran en la cartera. El unico punto en el que se tocan
 * es la valoracion del clic, y esa se comparte con `clickValue` precisamente para que no divergan.
 *
 * Que el total nunca baje del score es una propiedad, no una casualidad: el booster solo multiplica,
 * nunca divide, asi que `expectedVynarPoints >= expectedScore` siempre. Si algun dia aparece un
 * resultado por debajo, hay un signo cambiado por el camino.
 */
export function expectedVynarPoints(result: GameResult, seed: Hex, arena: ArenaConfig | ArenaType): VynarPoints {
  const config = typeof arena === 'string' ? arenaByType(arena) : arena
  if (!config) throw new Error('ARENA_UNKNOWN')
  const rules = config.gameplay
  const { scoring, shield, booster } = rules
  const hits = classifyClicks(result.events, seed, rules)
  // `?? []` for the same reason as in `expectedScore`: absence is "I don't use it".
  const shieldActivations = result.shieldActivations ?? []
  const boosterActivations = result.boosterActivations ?? []
  const total = result.events.reduce((sum, event, index) => {
    // The shield and the booster ask different things and that's why they can combine. The shield
    // decides IF the click scores (and therefore if there's VYNAR to multiply); the booster decides if that
    // value gets doubled. A miss saved by the shield inside the booster window is worth double,
    // which is the combination that pays for the booster: extending the reach of a known miss.
    const scored = Boolean(hits[index]) || Boolean(shield && shieldActiveAt(shieldActivations, shield, event.atMs))
    const value = clickValue(scoring, event, scored)
    if (value === 0) return sum
    return sum + applyBps(value, booster && boosterActiveAt(boosterActivations, booster, event.atMs) ? booster.multiplierBps : 10_000)
  }, 0)
  return asVynarPoints(total)
}

/**
 * Comprueba que un total de VYNAR sea coherente con las reglas, para un mint que llega desde fuera
 * (una recuperacion, un cron) y no desde un calculo en memoria.
 */
export function vynarPointsRangeError(value: unknown, rules: GameplayRules, score: number): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 'vynar_shape'
  if (value < score) return 'vynar_below_score'
  if (value > maxVynarPointsFor(rules)) return 'vynar_above_max'
  return null
}
