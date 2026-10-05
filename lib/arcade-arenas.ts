import type { ArenaType } from './arcade-types'

// Re-exported because the registry is where you look up "what is an arena". The canonical
// definition stays in arcade-types.ts so that module has no dependencies.
export type { ArenaType }

/**
 * Unique arena registry. Pure module: no `server-only`, no env, no DB, so vitest can import it.
 * Any value that both client and server must share comes from here.
 *
 * THE NUMERIC ID IS CRITICAL. Must match `enum ArenaType` in ArcadeVaultV6:
 *
 *     enum ArenaType { HUMAN, MEDIUM, HARD, AGENT }   // 0, 1, 2, 3
 *
 * In V5 AGENT was 1 and moves to 3. A persisted id that meant `agent` now means `medium`,
 * and a score signed for one arena would be filed under the wrong one, with the prize
 * paid to the wrong player. `tests/arcade-arenas.test.ts` is the safety net.
 */

export type ArenaId = 0 | 1 | 2 | 3

export const ARENA_IDS = {
  human: 0,
  medium: 1,
  hard: 2,
  agent: 3,
} as const satisfies Record<ArenaType, ArenaId>

/** 0.02 SVP. The flat fee the staker receives per entry, same in all three modes. */
export const PROTOCOL_FEE_FLAT_WEI = BigInt('20000000000000000')

/** 24h epochs in production. */
export const EPOCH_DURATION_SECONDS = 86_400

/**
 * WHAT THE SHIELD PROTECTS, which wasn't documented anywhere until now: the four fields
 * below described WHEN it can be used, never WHAT IT DOES.
 *
 * A click landing outside the target scores 0. That is the miss penalty, and the shield
 * blocks it: while active, the click scores its full value even if it missed.
 *
 * The penalty is NOT a fixed amount but the click's own value, deliberately. A `-100`
 * would have required inventing a constant that doesn't exist anywhere, and would have
 * made the score negative or forced clamping at zero, with two edge cases. "Worth zero"
 * falls out of values already here, keeps the score always >= 0, and doesn't touch
 * `maxScoreForRules` or the `score >= 0` bound. If a constant penalty is ever wanted,
 * it's a new field in this block and a change in `expectedScore`, not a loose number.
 *
 * That the shield increases the score does NOT make it a booster: a booster multiplies
 * VYNAR and never touches points. Here the shield only prevents a miss from being worth
 * less than it was.
 *
 * With `maxActivations: 1` and `cannotActivateAfterMs = 10_000` the math works out:
 * in `hard` (20s) activating covers 10s to 20s, i.e. the entire second half, and
 * letting it pass wastes it. In `medium` (25s) it covers 10s to 20s and the last 5s
 * are uncovered, so you must choose earlier. That's why `durationMs` equal to
 * `cannotActivateAfterMs` isn't redundant: activating late is wasted time.
 */
export type ShieldRules = {
  /** Active shield duration. */
  durationMs: number
  /** After this point in the round the shield can no longer be activated. */
  cannotActivateAfterMs: number
  /** How many activations are allowed per round. */
  maxActivations: number
  /** Time to wait between activations. */
  cooldownMs: number
}

/**
 * WHAT A BOOSTER IS, AND WHY IT'S NOT A SHIELD BY ANOTHER NAME
 *
 * The shield and booster look similar in form (both activate at a moment in the round
 * and cover a segment) but are opposites in what they affect:
 *
 *   - the SHIELD is free, provided by the arena, and changes the SCORE: a miss goes from
 *     worth 0 to worth its full value. `gameplay.shield`.
 *   - the BOOSTER is PAID in VYNAR, and doesn't change the score by a single point.
 *     It doubles the VYNAR of clicks falling inside its window and nothing else.
 *     `gameplay.booster`.
 *
 * This separation is structural, not convention: the score goes to `recordScore` and
 * VYNAR to `mintForScoreOnce`, which are two distinct transactions with two distinct
 * arguments. The booster can only touch the second, so a leaderboard, an epoch prize,
 * or `arcade_scores_best` cannot be affected by it even if the mint code is wrong.
 *
 * THE 10-SECOND WINDOW
 *
 * `durationMs` is what bounds the 2x, and it's 10s. The window is [activation,
 * activation + 10s): closed on the left, open on the right, same as the shield and
 * for the same reason: two activations must not overlap by a millisecond.
 *
 * The VYNAR mint is A SINGLE SHOT per round (`mintForScoreOnce` with
 * `rewardId = sessionId`), so there's no VYNAR amount that "accumulates during the
 * window": the 2x can only be expressed as the click-weighted total, and the per-click
 * weighting is what makes the duration meaningful. That's why the window applies to
 * clicks, not the whole round.
 *
 * WHY THERE'S NO `cannotActivateAfterMs`
 *
 * The shield has that limit and the booster doesn't, and the difference is deliberate.
 * The shield is free and part of the arena's balance: activating late is wasted time
 * the server can refuse to accept. The booster is paid for, so a deadline would only
 * punish the buyer. The limit protecting the economy here is the PRICE and the WINDOW
 * DURATION, not an expiration date.
 *
 * Activating late is never more profitable than activating early, because click value
 * decays over time (`base + (decayWindowSeconds - t) * bonusPerSecond`): doubling a
 * click at second 1 is worth more than doubling five clicks at second 25. No rule is
 * needed to prevent it because the formula itself disincentivizes it, and adding the
 * rule would only create a 422 on a legitimate use.
 */
export type BoosterRules = {
  /** VYNAR multiplier in bps. 20_000 is 2x. Never applied to points. */
  multiplierBps: number
  /** Duration of the 2x window from activation. */
  durationMs: number
  /** How many activations allowed per round. Each spends one purchased unit. */
  maxActivations: number
  /** Time to wait between activations. Empty with `maxActivations: 1`, but checked anyway. */
  cooldownMs: number
}

/**
 * The total VYNAR-points for a round, marked as a distinct type.
 *
 * Exists because `score` and `vynarPoints` are both `number` and appear in the same
 * order in the same calls, so passing one for the other —the bug that makes a round
 * with booster mint the total without 2x when recovering a partial mint— compiles
 * cleanly. Verified: with the two functions in `lib/server-blockchain.ts` taking
 * positional args, the bug was invisible to `tsc`. A named-object parameter helps
 * readability but doesn't prevent it, because `{ vynarPoints: someNumber }` still
 * accepts any `number`.
 *
 * With a nominal type, `vynarPoints` is no longer assignable from `score` without
 * an explicit `as`, and that `as` is exactly the point where someone has to decide
 * they know what they're doing. The cost is one cast at the only place where the
 * number enters from the database.
 *
 * WHAT THIS DOESN'T COVER, and it's important not to overstate it: `pending.data`
 * comes from PostgREST untyped, i.e. `any`, and an `any` assigns to any type
 * without complaint. The brand stops `claimedScore` or any other named `number`
 * from being passed —which is the bug a refactor introduces— but does NOT stop
 * `pending.data.score` being passed where the correct column has the same name.
 * That hole is covered by `asVynarPoints` being the only `as` in the repo, with
 * the conversion visible, plus the column immutability trigger: if the stored
 * `vynar_points` doesn't change, the recovery mint can't change either.
 */
export type VynarPoints = number & { readonly __vynarPoints: unique symbol }

/** Marks a number already validated as a VYNAR total. Only place in the repo this is used. */
export function asVynarPoints(value: number): VynarPoints {
  return value as VynarPoints
}

export type ScoringRules = {
  /** Base points per event. */
  base: number
  /** Additional bonus per full second within the window. */
  bonusPerSecond: number
  /** Seconds from start during which the bonus still applies. */
  decayWindowSeconds: number
}

export type GameplayRules = {
  maxDurationMs: number
  maxEvents: number
  minEventIntervalMs: number
  /**
   * MEDIA TOLERANCIA en porcentaje, no en pixeles. Un clic acierta si `|event.x - target.x| <= t` Y
   * `|event.y - target.y| <= t`, donde `x` es porcentaje del ancho del area de juego e `y` del alto.
   *
   * Dos consecuencias que hay que tener presentes al tocar esto:
   *
   * 1. La zona de acierto es una ELIPSE, no un circulo, y su forma depende de la relacion de
   *    aspecto del area. Con un area de 700x450, una tolerancia de 3 son 21px en horizontal y 13.5px
   *    en vertical. La UI lo resuelve dando al elemento `width: 2t%` y `height: 2t%`, que produce
   *    justo esa elipse sin medir nada, en vez de dibujar un circulo que no es lo que puntua.
   * 2. Los valores tienen que dar una zona comoda de acertar. Con 4/3/2 la zona de `hard` eran
   *    28x18px en escritorio, por debajo del minimo tactil orientativo de 44px, y ademas el circulo
   *    que se veia media 48px: clicar dentro de lo que se veia podia no puntuar nada, sin forma de
   *    saberlo. De ahi 6/5/4.
   *
   *    LO QUE 6/5/4 NO RESUELVE, porque conviene no deceive oneself luego: una tolerancia en
   *    porcentaje no puede ser a la vez objetivo tactil en un movil estrecho y juego de punteria.
   *    Zona real, con area de juego de 700x450 en escritorio y 340x450 en movil:
   *
   *        tolerancia    escritorio     movil
   *             6         84x54 px     41x54 px
   *             5         70x45 px     34x45 px
   *             4         56x36 px     27x36 px   <- `hard`
   *
   *    Solo `human` llega a 44px en ambos ejes, y solo en escritorio. En movil el eje corto es el
   *    ancho, y para llegar a 44px ahi haria falta tolerancia 13, con lo que un radio del 13% se
   *    solaparia con practicamente todos los centros posibles de `targetRange` (12..88) y el juego
   *    dejaria de ser de punteria. Subir la tolerancia mas alla de 6 no compra accesibilidad: compra
   *    un juego donde casi todo clic acierta. Lo que si funciona, y es lo que se ha hecho, es que la
   *    zona dibujada SEA la zona que puntua y que el color diga si el ultimo clic acerto, para que al
   *    menos el jugador pueda calibrar. `hard` sigue siendo el mas dificil por la velocidad, el
   *    decaimiento del bonus y el intervalo minimo entre eventos, no por la punteria de subpixel.
   *
   *    Para cambiar este reparto sin perder el efecto de la mecanica habria que hacer la tolerancia
   *    relative a la dimension MENOR del area, y eso exige que el area se declare al crear la
   *    sesion y no al enviar el resultado: si la declara el cliente, elige la caja y con ella la
   *    tolerancia.
   */
  targetTolerance: number
  targetRange: { minX: number; maxX: number; minY: number; maxY: number }
  scoring: ScoringRules
  /** `null` en las arenas sin escudo. */
  shield: ShieldRules | null
  /**
   * `null` donde no hay booster. Se declara por arena aunque hoy valga lo mismo en las tres
   * jugables: es el sitio donde una diferencia futura tiene que quedar escrita, no repartida por el
   * codigo que las consume. La diferencia con `shield` es que el booster se compra, asi que se
   * ofrece en todas las arenas jugables en vez de ser una propiedad del equilibrio de cada una.
   */
  booster: BoosterRules | null
}

export type ArenaConfig = {
  id: ArenaId
  type: ArenaType
  label: string
  entryFeeWei: bigint
  protocolFeeBps: number
  maxEntries: number
  epochDurationSeconds: number
  /** Si la arena puede jugarse. `agent` existe en la BD pero quedo fuera de alcance. */
  playable: boolean
  gameplay: GameplayRules
}

const HUMAN_TARGET_RANGE = { minX: 12, maxX: 88, minY: 18, maxY: 83 } as const

/**
 * Reglas de booster de las arenas jugables. UNA constante compartida y no tres literales: tres
 * copias de un `20_000` y un `10_000` son tres sitios que se pueden desincronizar, y cuando lo que
 * se desincroniza es un multiplicador de VYNAR la desincronizacion es dinero. Es el mismo motivo
 * por el que `HUMAN_TARGET_RANGE` no se repite en las cuatro arenas.
 *
 * Que la ventana de 10s sea la misma en las tres no significa que cubra lo mismo, porque las rondas
 * no duran igual. Es la cobertura maxima de la ventana, si se activa en el segundo 0:
 *
 *        arena    ronda      ventana      cobertura
 *       human    30s        10s           un tercio
 *       medium   25s        10s           dos quintos
 *       hard     20s        10s           la mitad
 *
 * Con `maxActivations: 1` el jugador elige CUANDO abrirla, y no hay forma de gastar mas de una
 * unidad por partida. Dos ventanas no se acumulan: un clic que cae dentro de dos activaciones
 * cuenta 2x, no 4x, porque la pregunta que se le hace al clic es "estas dentro de alguna ventana",
 * no "cuantas ventanas te cubren". Sin esa regla, tres activaciones seguidas en una ronda de 20s
 * darian 8x sobre el tramo que se solapan.
 */
const PLAYABLE_BOOSTER: BoosterRules = { multiplierBps: 20_000, durationMs: 10_000, maxActivations: 1, cooldownMs: 10_000 }

/**
 * El fee plano se reproduce con bps distintos segun el precio de la entrada, para que el
 * staker reciba SIEMPRE 0.02 y el ingreso no dependa del modo.:
 *
 *     0.1 SVP * 2000 bps = 0.02      0.5 SVP * 400 bps = 0.02      1.0 SVP * 200 bps = 0.02
 *
 * El bps tiene que quedar por debajo de `MAX_PROTOCOL_FEE_BPS = 3000` del contrato; si no,
 * `setProtocolFee` revierte y el deploy se rompe.
 */
export const ARENAS: readonly ArenaConfig[] = [
  {
    id: ARENA_IDS.human,
    type: 'human',
    label: 'Human',
    entryFeeWei: BigInt('100000000000000000'),
    protocolFeeBps: 2000,
    maxEntries: 50,
    epochDurationSeconds: EPOCH_DURATION_SECONDS,
    playable: true,
    gameplay: {
      maxDurationMs: 30_000,
      maxEvents: 60,
      minEventIntervalMs: 60,
      targetTolerance: 6,
      targetRange: HUMAN_TARGET_RANGE,
      scoring: { base: 100, bonusPerSecond: 10, decayWindowSeconds: 30 },
      shield: null,
      booster: PLAYABLE_BOOSTER,
    },
  },
  {
    id: ARENA_IDS.medium,
    type: 'medium',
    label: 'Medium',
    entryFeeWei: BigInt('500000000000000000'),
    protocolFeeBps: 400,
    maxEntries: 20,
    epochDurationSeconds: EPOCH_DURATION_SECONDS,
    playable: true,
    gameplay: {
      maxDurationMs: 25_000,
      maxEvents: 60,
      minEventIntervalMs: 55,
      targetTolerance: 5,
      targetRange: HUMAN_TARGET_RANGE,
      scoring: { base: 100, bonusPerSecond: 12, decayWindowSeconds: 20 },
      shield: { durationMs: 10_000, cannotActivateAfterMs: 10_000, maxActivations: 1, cooldownMs: 10_000 },
      booster: PLAYABLE_BOOSTER,
    },
  },
  {
    id: ARENA_IDS.hard,
    type: 'hard',
    label: 'Hard',
    entryFeeWei: BigInt('1000000000000000000'),
    protocolFeeBps: 200,
    maxEntries: 10,
    epochDurationSeconds: EPOCH_DURATION_SECONDS,
    playable: true,
    gameplay: {
      maxDurationMs: 20_000,
      maxEvents: 60,
      minEventIntervalMs: 50,
      targetTolerance: 4,
      targetRange: HUMAN_TARGET_RANGE,
      scoring: { base: 100, bonusPerSecond: 15, decayWindowSeconds: 15 },
      shield: { durationMs: 10_000, cannotActivateAfterMs: 10_000, maxActivations: 1, cooldownMs: 10_000 },
      booster: PLAYABLE_BOOSTER,
    },
  },
  {
    // Reserved, not playable. Keeps an id and nominal params because the registry validates
    // constraints and the contract reserves the slot even though the arena is off.
    // Not activated with `setArenaActive` until the mode exists.
    id: ARENA_IDS.agent,
    type: 'agent',
    label: 'Agent',
    entryFeeWei: BigInt('100000000000000000'),
    protocolFeeBps: 2000,
    maxEntries: 50,
    epochDurationSeconds: EPOCH_DURATION_SECONDS,
    playable: false,
    gameplay: {
      maxDurationMs: 30_000,
      maxEvents: 60,
      minEventIntervalMs: 60,
      targetTolerance: 4,
      targetRange: HUMAN_TARGET_RANGE,
      scoring: { base: 100, bonusPerSecond: 10, decayWindowSeconds: 30 },
      shield: null,
      booster: null,
    },
  },
]

const BY_ID = new Map<number, ArenaConfig>(ARENAS.map((a) => [a.id, a]))
const BY_TYPE = new Map<ArenaType, ArenaConfig>(ARENAS.map((a) => [a.type, a]))

export function arenaById(id: ArenaId): ArenaConfig | undefined {
  return BY_ID.get(id)
}

export function arenaByType(type: ArenaType): ArenaConfig | undefined {
  return BY_TYPE.get(type)
}

/** `false` para `agent`. Usar esto, no comparar contra 'human', para no hardcodear el modo. */
export function isPlayable(type: ArenaType): boolean {
  return BY_TYPE.get(type)?.playable ?? false
}

/**
 * Fee del protocolo para una arena, en wei. Usa aritmetica entera y trunca hacia abajo:
 * el redondeo favorece al vault, nunca al staker ni al treasury.
 */
export function flatFeeWei(arena: ArenaConfig): bigint {
  return (arena.entryFeeWei * BigInt(arena.protocolFeeBps)) / BigInt(10_000)
}

/** Puntuacion maxima posible en la arena, derivada de sus reglas y no cableada. */
export function maxScoreFor(type: ArenaType): number {
  const arena = BY_TYPE.get(type)
  if (!arena) return 0
  const { scoring, maxEvents } = arena.gameplay
  return maxEvents * (scoring.base + scoring.decayWindowSeconds * scoring.bonusPerSecond)
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived aliases, NOT independent values.
//
// Antes de la migracion, `HUMAN_ARENA` y `HUMAN_ENTRY_FEE` vivian en lib/arcade-vault-v5-abi.ts
// and in lib/arcade-vault-v6-abi.ts at the same time. Two copies of the same mapping is exactly
// the desync class that makes a persisted id change meaning between
// deployments: AGENT went from 1 to 3 and nobody noticed because there wasn't a single place to
// update. Now they come from ARENAS, so they can't desync.
// ─────────────────────────────────────────────────────────────────────────────
export const HUMAN_ENTRY_FEE = BY_TYPE.get('human')!.entryFeeWei
export const MEDIUM_ENTRY_FEE = BY_TYPE.get('medium')!.entryFeeWei
export const HARD_ENTRY_FEE = BY_TYPE.get('hard')!.entryFeeWei
export const AGENT_ENTRY_FEE = BY_TYPE.get('agent')!.entryFeeWei

/** Entry fee in SVP per arena, indexed by type, for iterating code. */
export const ENTRY_FEE_BY_TYPE: Record<ArenaType, bigint> = {
  human: HUMAN_ENTRY_FEE,
  medium: MEDIUM_ENTRY_FEE,
  hard: HARD_ENTRY_FEE,
  agent: AGENT_ENTRY_FEE,
}

/**
 * Lee el modo de un query param y devuelve `undefined` para lo que no sea un modo jugable.
 *
 * Normaliza mayusculas y espacios recorteados (`' Medium '` es medium), porque una query de URL es
 * texto escrito por una persona y rechazarla por un espacio no es una decision de seguridad, es
 * una molestia que enseña al usuario a escribir la direccion a mano.
 *
 * Se acepta tambien el id numerico porque el contrato habla en ids y el cliente en texto; cualquier
 * otra cosa se rechaza. Aceptar el id evita que el cliente tenga que mantener una tabla id<->nombre
 * que se desincronizaria del registro justo cuando una arena cambia de sitio.
 *
 * `undefined` significa lo mismo para lo AUSENTE y para lo INVALIDO. Quien llame tiene que
 * distinguirlo, porque las dos cosas no se pueden tratar igual; para eso esta `resolveArenaParam`.
 */
export function parseArenaParam(raw: string | null | undefined): ArenaType | undefined {
  if (!raw) return undefined
  const value = raw.trim().toLowerCase()
  if (isPlayable(value as ArenaType)) return value as ArenaType
  if (!/^\d+$/.test(value)) return undefined
  const config = arenaById(Number(value) as ArenaId)
  return config?.playable ? config.type : undefined
}

/**
 * `parseArenaParam` para rutas de API: separa AUSENTE de INVALIDO en vez de devolver `undefined`
 * para los dos.
 *
 * Existe porque las dos respuestas correctas son distintas y opuestas:
 *
 *   - AUSENTE -> `fallback` (por defecto `human`). Es el caso normal de una llamada que nunca
 *     lleva el parametro.
 *   - INVALIDO -> `ok: false`. Un `?arena=inventado` NO puede caer al default: la respuesta seria
 *     una lista coherente y equivocada, que es la peor forma de fallar porque el jugador no ve
 *     ningun sintoma. Un 400 dice exactamente lo que paso.
 *
 * `fromDefault` viaja en el resultado para que quien llame pueda distinguir en la respuesta o en el
 * log si esta mirando el modo que pidio o el que leedi por defecto. Sin eso, un fallo de filtrado
 * es indistinguible de "este wallet no tiene nada en este modo".
 *
 * El unico sitio que NO puede aplicar esta regla es `/api/play`: su 402 tiene que anunciar el
 * precio del modo pedido para que el wallet firme por la cantidad correcta, asi que ahi lo ausente
 * y lo invalido caen ambos a `human` a proposito. Si alguna vez se cambia esa ruta, hay que mover
 * el fallo del 402 a la verificacion del importe, no relajar el default.
 *
 * Un `fallback` que el registro no declara jugable lanza. Es un error de programacion —el codigo
 * llamador nombro una arena que no existe— y devolver un 400 lo convertiria en un bug de servidor
 * invisible, indistinguible de una peticion del usuario mal formada.
 */
export type ArenaParamResult = { ok: true; arena: ArenaConfig; fromDefault: boolean } | { ok: false; raw: string }

export function resolveArenaParam(raw: string | null | undefined, fallback: ArenaType = 'human'): ArenaParamResult {
  const type = parseArenaParam(raw)
  if (type) return { ok: true, arena: arenaByType(type)!, fromDefault: false }
  // Absent, or present but empty (`?arena=` with no value). An empty param is treated as
  // absent: the player typed the name and forgot, they didn't ask for an arena called "".
  if (raw === null || raw === undefined || raw.trim() === '') {
    const arena = arenaByType(fallback)
    if (!arena?.playable) throw new Error('UNPLAYABLE_ARENA_FALLBACK: ' + fallback)
    return { ok: true, arena, fromDefault: true }
  }
  return { ok: false, raw }
}
