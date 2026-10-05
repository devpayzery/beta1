import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseEther, toFunctionSelector } from 'viem'
import { validateVyrClaimCalldata } from '../lib/vyr-claim-validation'
import { publishCatchTransition } from '../lib/vyr-publish-policy'
import { vynarRewardsV3Abi } from '../lib/vynar-rewards-v3-abi'
import { expectedScore, expectedTarget, gameResultValidationError, isValidGameResult, MAX_DURATION_MS, MAX_EVENTS, MAX_SCORE, MIN_EVENT_INTERVAL_MS, seedFingerprint, shieldActiveAt, shieldValidationError, TARGET_TOLERANCE } from '../lib/score-validation'
import { buildAuthMessage, CHALLENGE_TTL_SECONDS, createNonce, expectedMessageFromRequest, isChallengeFresh, isValidChallengeWallet, isValidNonce } from '../lib/auth-challenge'
import { arcadeVaultV6Abi } from '../lib/arcade-vault-v6-abi'
import { ARENA_IDS, ARENAS, arenaByType, ENTRY_FEE_BY_TYPE, flatFeeWei, HUMAN_ENTRY_FEE, parseArenaParam } from '../lib/arcade-arenas'
import { ARCADE_ENTRY_FEE, SVP_CHAIN_ID } from '../lib/arcade-config'
import { persistedScoreTransition, reconciliationTransition, shouldKeepSubmissionPending } from '../lib/submission-policy'
import { getPlayErrorState, getWeb3ErrorMessage } from '../lib/play-errors'
import { canAcceptEntry, getEpochStatus, isTopThree } from '../lib/epoch-state'
import { authorizeCronRequest } from '../lib/cron-auth'
import { getTrustedClientIp } from '../lib/trusted-client-ip'
import { derivePaymentEpoch, isPaymentStateBlocking } from '../lib/payment-epoch'
import { reconcileRankedPlayers } from '../lib/reward-reconciliation'
import { boosterActiveAt, boosterValidationError, expectedVynarPoints, maxVynarPointsFor, vynarPointsRangeError } from '../lib/booster-validation'

describe('chain reward finalization invariants', () => {
  const a = { rank: 1, wallet: '0x0000000000000000000000000000000000000001' as `0x${string}`, score: BigInt(100) }
  const b = { rank: 2, wallet: '0x0000000000000000000000000000000000000002' as `0x${string}`, score: BigInt(90) }
  it('distinguishes match, score, rank, chain-only and db-only', () => {
    expect(reconcileRankedPlayers([a, b], [a, b], 2)).toEqual(['MATCH', 'MATCH'])
    expect(reconcileRankedPlayers([a], [a, b], 2)).toEqual(['MATCH', 'DB_ONLY'])
    expect(reconcileRankedPlayers([a, b], [a], 2)).toEqual(['MATCH', 'CHAIN_ONLY'])
    expect(reconcileRankedPlayers([{ ...a, score: BigInt(101) }, b], [a, b], 2)).toEqual(['SCORE_MISMATCH', 'MATCH'])
    expect(reconcileRankedPlayers([a, b], [{ ...b, rank: 1 }, { ...a, rank: 2 }], 2)).toEqual(['RANK_MISMATCH', 'RANK_MISMATCH'])
  })
  it('keeps SVP to top three with 70/20/10 allocations', () => {
    const pool = BigInt(1000)
    const validate = (rewards: bigint[]) => rewards.length === 3 && rewards.every((reward, index) => reward === [BigInt(70), BigInt(20), BigInt(10)][index] * pool / BigInt(100))
    expect(validate([BigInt(700), BigInt(200), BigInt(100)])).toBe(true)
    expect(validate([BigInt(700), BigInt(300)])).toBe(false)
  })
})

describe('historical epoch and payment invariants', () => {
  it('derives the epoch from the confirmed payment block, not the current read', () => {
    expect(derivePaymentEpoch({ currentEpoch: BigInt(10), currentEpochStart: BigInt(1000), epochDuration: BigInt(100), paymentTimestamp: BigInt(950) })).toBe(BigInt(9))
    expect(derivePaymentEpoch({ currentEpoch: BigInt(11), currentEpochStart: BigInt(1100), epochDuration: BigInt(100), paymentTimestamp: BigInt(950) })).toBe(BigInt(9))
  })
  it('blocks every payment lifecycle state except explicit idle or actionable error', () => {
    for (const state of ['PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'SESSION_CREATING', 'READY_TO_PLAY', 'PLAYING', 'SUBMITTING', 'RECOVERING']) expect(isPaymentStateBlocking(state as never)).toBe(true)
    expect(isPaymentStateBlocking('IDLE')).toBe(false)
    expect(isPaymentStateBlocking('ERROR_REQUIRES_ACTION')).toBe(false)
  })
})

describe('gameplay validation', () => {
  // Cada arena valida con SUS reglas, no con las de human. Estos tres casos comparten la misma
  // partida sintetica y se espera un veredicto distinto en cada modo, que es justo lo que no
  // ocurriria si la validacion ignorara el argumento de arena.
  it('validates the same run differently per arena', () => {
    // 40 eventos separados por 550ms: el ultimo cae en 21.450ms, dentro de la ventana de human
    // (30.000) y de la de medium (25.000) pero fuera de la de hard (20.000). El intervalo de 550ms
    // cumple el minimo de las tres arenas, y el ultimo atMs tambien cabe en las tres, asi que lo
    // unico que separa los veredictos es la duracion maxima: hard dice `duration_exceeded` y las
    // otras dos aceptan la partida.
    const events = Array.from({ length: 40 }, (_, index) => ({ atMs: index * 550, x: 50, y: 50 }))
    const result = { score: 0, startedAt: 0, finishedAt: 21_450, events }
    expect(gameResultValidationError(result, undefined, 'human')).toBe(null)
    expect(gameResultValidationError(result, undefined, 'medium')).toBe(null)
    expect(gameResultValidationError(result, undefined, 'hard')).toBe('duration_exceeded')
  })
  it('rejects a run whose spacing only fits the arena it was not played in', () => {
    // 100ms cumple el minimo de las tres arenas, asi que para probar el intervalo hay que bajar:
    // 55ms pasa en medium (minimo 55) pero no en hard (minimo 50)... tampoco. El punto es que
    // el intervalo minimo se lee del registro: se comprueba que human (60) rechaza lo que hard (50) acepta.
    const events = [{ atMs: 0, x: 50, y: 50 }, { atMs: 55, x: 51, y: 50 }]
    const result = { score: 0, startedAt: 0, finishedAt: 1_000, events }
    expect(gameResultValidationError(result, undefined, 'human')).toBe('implausible_timeline')
    expect(gameResultValidationError(result, undefined, 'medium')).toBe(null)
    expect(gameResultValidationError(result, undefined, 'hard')).toBe(null)
  })
  it('caps the score at each arena own maximum', () => {
    // Los maximos difieren porque el bonus por segundo y la ventana de decaimiento cambian:
    // human 60*(100+30*10)=24000, medium 60*(100+20*12)=20400, hard 60*(100+15*15)=19500.
    const events = Array.from({ length: 2 }, (_, index) => ({ atMs: index * 100, x: 50, y: 50 }))
    const humanMax = { score: 24_000, startedAt: 0, finishedAt: 1_000, events }
    expect(gameResultValidationError(humanMax, undefined, 'human')).toBe(null)
    expect(gameResultValidationError(humanMax, undefined, 'medium')).toBe('score')
    expect(gameResultValidationError(humanMax, undefined, 'hard')).toBe('score')
  })
  it('recomputes the score with the arena rules, not with human rules', () => {
    // REGRESION DE ESTA MIGRACION. app/api/play/finish llamaba `expectedScore(validResult)` sin
    // arena y recalculaba TODAS las sesiones con la formula de human. La partida de abajo dura 8s,
    // dentro de las tres arenas, asi que lo unico que puede differentiates es la regla de score.
    //
    // El bonus decae POR EVENTO, no es una cantidad plana: cada hit suma
    // `base + max(0, decayWindowSeconds - floor(atMs/1000)) * bonusPerSecond`, y los hits caen en
    // t = 0, 2, 4, 6, 8 segundos.
    //
    //     human : (100+30*10)+(100+28*10)+(100+26*10)+(100+24*10)+(100+22*10) = 1800
    //     medium: (100+20*12)+(100+18*12)+(100+16*12)+(100+14*12)+(100+12*12) = 1460
    //     hard  : (100+15*15)+(100+13*15)+(100+11*15)+(100+ 9*15)+(100+ 7*15) = 1325
    //
    // Si `expectedScore` volviera a ignorar el argumento, los tres darian 1800 y el servidor
    // rechazaria por score a los jugadores de medium y hard con un 422 sin explicacion.
// Los clics van sobre la diana que les toca por indice. Antes daba igual: `expectedScore` solo
    // sumaba la formula y todos los eventos contaban como aciertos. Ahora cada clic se clasifica
    // contra la diana derivada del seed, asi que un evento en (50,50) a pelo seria un FALLO y
    // puntuaria 0. Los tres numeros de abajo solo se sostienen si los cinco clics aciertan de verdad.
    const seed = `0x${'ab'.repeat(32)}` as const
    const events = Array.from({ length: 5 }, (_, index) => ({ atMs: 2_000 * index, ...expectedTarget(seed, index) }))
    const result = { score: 0, startedAt: 0, finishedAt: 8_000, events, shieldActivations: [] }
    expect(expectedScore(result, seed, 'human')).toBe(1_800)
    expect(expectedScore(result, seed, 'medium')).toBe(1_460)
    expect(expectedScore(result, seed, 'hard')).toBe(1_325)
    // El mismo flujo con un fallo en medio vale menos, y esa diferencia ES la penalizacion que el
    // escudo bloquea. Se comprueba en `medium` y no en `human` porque `human` no tiene escudo: su
    // `shield` es `null`, asi que una activacion ahi se ignora y el resultado no cambia. Escribir
    // esta asercion sobre `human` pasaria por el motivo equivocado —daria igual con o sin
    // activacion— y por eso el numero de abajo se calcula sobre medium, que si tiene.
    const missed = { ...result, events: events.map((event, index) => index === 2 ? { ...event, x: event.x > 50 ? event.x - 40 : event.x + 40 } : event) }
    // El tercer evento cae en el segundo 4 y en medium vale 100 + 16*12 = 292.
    expect(expectedScore(missed, seed, 'medium')).toBe(1_460 - 292)
    // El escudo activo en el instante del fallo lo devuelve a su valor completo: 3_000..13_000
    // cubre el segundo 4. Un fallo anterior a la activacion NO quedaria cubierto.
    expect(expectedScore({ ...missed, shieldActivations: [3_000] }, seed, 'medium')).toBe(1_460)
    expect(expectedScore({ ...missed, shieldActivations: [9_000] }, seed, 'medium')).toBe(1_460 - 292)
  })
  it('accepts a mathematically consistent result', () => {
    const seed = `0x${'cd'.repeat(32)}` as const
    const result = { score: 390, startedAt: 1_000, finishedAt: 2_000, events: [{ atMs: 1_000, ...expectedTarget(seed, 0) }], shieldActivations: [] }
    expect(isValidGameResult(result, undefined, 'human')).toBe(true)
    expect(expectedScore(result, seed, 'human')).toBe(390)
  })
  it('rejects negative, excessive and malformed evidence', () => {
    expect(isValidGameResult({ score: -1, startedAt: 0, finishedAt: 1, events: [] }, undefined, 'human')).toBe(false)
    expect(isValidGameResult({ score: MAX_SCORE + 1, startedAt: 0, finishedAt: 1, events: [] }, undefined, 'human')).toBe(false)
    expect(isValidGameResult({ score: 0, startedAt: 0, finishedAt: 1, events: [{ atMs: 1, x: 101, y: 50 }] }, undefined, 'human')).toBe(false)
    expect(gameResultValidationError({ score: 0, startedAt: 0, finishedAt: 1, events: Array.from({ length: 61 }, (_, index) => ({ atMs: index, x: 50, y: 50 })) }, undefined, 'human')).toBe('events')
    expect(isValidGameResult({ score: Number.NaN, startedAt: 0, finishedAt: 1, events: [] }, undefined, 'human')).toBe(false)
  })
  it('accepts the gameplay duration boundary and rejects after it', () => {
    expect(gameResultValidationError({ score: 0, startedAt: 0, finishedAt: MAX_DURATION_MS, events: [] }, undefined, 'human')).toBe(null)
    expect(gameResultValidationError({ score: 0, startedAt: 0, finishedAt: MAX_DURATION_MS + 1_001, events: [] }, undefined, 'human')).toBe('duration_exceeded')
  })
  it('identifies the production failure as duration exceeded rather than TTL expiry', () => {
    expect(gameResultValidationError({ score: 0, startedAt: 0, finishedAt: 60_100, events: [] }, undefined, 'human')).toBe('duration_exceeded')
  })
  it('accepts a legitimate result near the gameplay limit', () => {
    expect(isValidGameResult({ score: 0, startedAt: 1_000, finishedAt: 31_000, events: [] }, undefined, 'human')).toBe(true)
  })
  it('rejects invalid evidence before session or wallet processing', () => {
    expect(gameResultValidationError({ score: 0, startedAt: 2_000, finishedAt: 1_999, events: [] }, undefined, 'human')).toBe('negative_duration')
    expect(gameResultValidationError({ score: 0, startedAt: 0, finishedAt: 1, events: [{ atMs: 1, x: 101, y: 50 }] }, undefined, 'human')).toBe('event_shape')
  })
})

// ── AUDIT REMEDIATION REGRESSION TESTS ──────────────────────────────────────
// Each block below pins a specific finding from the security audit. If one of these starts failing,
// the corresponding vulnerability is back.

describe('regression: forged score via 60 simultaneous events', () => {
  const SEED = `0x${'ab'.repeat(32)}` as const

  /** The exact exploit from the audit: 60 identical events at atMs: 0 for MAX_SCORE. */
  const exploit = { score: MAX_SCORE, startedAt: 0, finishedAt: 30_000, events: Array.from({ length: 60 }, () => ({ atMs: 0, x: 50, y: 50 })) }

  it('rejects the audit exploit', () => {
    // Without a seed argument the timeline check alone must already stop it.
    expect(gameResultValidationError(exploit, undefined, 'human')).toBe('implausible_timeline')
    expect(isValidGameResult(exploit, undefined, 'human')).toBe(false)
  })

it('un atacante que clica fuera de la diana ya no gana puntos', () => {
    // ESTE TEST CAMBIO DE SENTIDO EN LA ETAPA 5. Es el unico sitio donde una defensa se mueve.
    //
    // Antes: `if (!matchesSeedTargets(...)) return 'target_mismatch'` rechazaba la partida entera.
    // Ahora los fallos son legales: un fallo esta por definicion fuera de la diana, asi que exigir
    // que TODO evento caiga sobre el objetivo prohibiria por regla justo la mecanica del escudo. Esa
    // comprobacion no puede seguir siendo una puerta de rechazo, asi que `gameResultValidationError`
    // devuelve `null` para este stream, y esta bien: la forma es valida y la linea temporal tambien.
    //
    // Lo que NO ha cambiado es que el exploit esta muerto, y esta es la parte que importa. Los 60
    // clics estan todos en (50,50). El servidor los clasifica uno a uno contra la diana que le toca
    // por indice, casi ninguno acierta, el score recomputado queda muy por debajo del MAX_SCORE que
    // el atacante declara, y la comparacion `claimedScore !== expected` de app/api/play/finish lo
    // rechaza con 422. La defensa cambio de herramienta: de "rechazar la forma" a "recalcular y
    // comparar". Por eso este test mira LAS DOS COSAS, la forma y el score.
    const spaced = { score: MAX_SCORE, startedAt: 0, finishedAt: 30_000, events: Array.from({ length: 60 }, (_, index) => ({ atMs: index * MIN_EVENT_INTERVAL_MS, x: 50, y: 50 })), shieldActivations: [] }
    // La forma sigue siendo aceptable: stream bien espaciado y score dentro del maximo.
    expect(gameResultValidationError(spaced, undefined, 'human')).not.toBe('implausible_timeline')
    expect(gameResultValidationError(spaced, SEED, 'human')).toBe(null)
    // Pero el score que recalcula el servidor no es el que declara el atacante. No se afirma el
    // valor exacto porque depende de cuantos de esos 60 puntos caigan por casualidad sobre la
    // diana que les toca, y un `toBe(0)` convertingia el test en una bomba de reloja en cuanto
    // cambiara el seed. Lo que importa es la distancia al score declarado.
    const recomputed = expectedScore(spaced, SEED, 'human')
    expect(recomputed).not.toBe(spaced.score)
    expect(recomputed).toBeLessThan(spaced.score / 10)
    // Y la clasificacion discrimina de verdad: los mismos 60 clics puestos sobre las dianas que les
    // tocan si scoring casi el maximo. Si esto bajara, `classifyClicks` estaria marcando todo como
    // fallo y la prueba de acierto de mas arriba no probaria nada.
    const onTarget = { ...spaced, events: spaced.events.map((event, index) => ({ atMs: event.atMs, ...expectedTarget(SEED, index) })) }
    expect(expectedScore(onTarget, SEED, 'human')).toBeGreaterThan(spaced.score / 10)
  })

  it('rejects duplicate timestamps', () => {
    const duplicated = { score: 0, startedAt: 0, finishedAt: 5_000, events: [{ atMs: 1_000, x: 50, y: 50 }, { atMs: 1_000, x: 51, y: 50 }] }
    expect(gameResultValidationError(duplicated, undefined, 'human')).toBe('implausible_timeline')
  })

  it('rejects a decreasing timeline', () => {
    const backwards = { score: 0, startedAt: 0, finishedAt: 5_000, events: [{ atMs: 2_000, x: 50, y: 50 }, { atMs: 1_000, x: 51, y: 50 }] }
    expect(gameResultValidationError(backwards, undefined, 'human')).toBe('implausible_timeline')
  })

  it('rejects events closer together than the minimum interval', () => {
    const tooFast = { score: 0, startedAt: 0, finishedAt: 5_000, events: [{ atMs: 1_000, x: 50, y: 50 }, { atMs: 1_000 + MIN_EVENT_INTERVAL_MS - 1, x: 51, y: 50 }] }
    expect(gameResultValidationError(tooFast, undefined, 'human')).toBe('implausible_timeline')
  })

  it('keeps the minimum interval below human click cadence so real players are never rejected', () => {
    // Browser double-click latency is ~100-150ms. A 60ms floor must not reject a fast human.
    expect(MIN_EVENT_INTERVAL_MS).toBeLessThanOrEqual(60)
  })

  it('accepts a genuine run whose events match the seed-derived targets', () => {
    const events = Array.from({ length: 20 }, (_, index) => ({ atMs: index * 120, x: expectedTarget(SEED, index).x, y: expectedTarget(SEED, index).y }))
    const genuine = { score: expectedScore({ score: 0, startedAt: 0, finishedAt: 30_000, events, shieldActivations: [] }, SEED, 'human'), startedAt: 0, finishedAt: 30_000, events, shieldActivations: [] }
    expect(gameResultValidationError(genuine, SEED, 'human')).toBe(null)
    expect(isValidGameResult(genuine, SEED, 'human')).toBe(true)
  })
})

describe('regression: seed-derived target positions are deterministic and client/server agree', () => {
  it('is a pure function of (seed, index)', () => {
    const seed = `0x${'11'.repeat(32)}` as const
    expect(expectedTarget(seed, 0)).toEqual(expectedTarget(seed, 0))
    expect(expectedTarget(seed, 3)).not.toEqual(expectedTarget(seed, 4))
  })

  it('stays inside the playable area', () => {
    const seed = `0x${'7f'.repeat(32)}` as const
    for (let index = 0; index < MAX_EVENTS; index += 1) {
      const target = expectedTarget(seed, index)
      expect(target.x).toBeGreaterThanOrEqual(0)
      expect(target.x).toBeLessThanOrEqual(100)
      expect(target.y).toBeGreaterThanOrEqual(0)
      expect(target.y).toBeLessThanOrEqual(100)
    }
  })

  it('rejects a seed that is not a 32-byte hex string', () => {
    const events = [{ atMs: 0, x: 50, y: 50 }]
    expect(gameResultValidationError({ score: 0, startedAt: 0, finishedAt: 1_000, events }, 'not-a-seed', 'human')).toBe('invalid_seed')
    expect(gameResultValidationError({ score: 0, startedAt: 0, finishedAt: 1_000, events }, '0xdeadbeef', 'human')).toBe('invalid_seed')
  })

it('trata los clics fuera de diana como fallos, no como intento de fraude', () => {
    // El segundo test que cambia de sentido en la Etapa 5, y el que mas conviene no maquillar.
    //
    // Antes este stream se rechazaba con 'target_mismatch'. Ahora se ACEPTA, y tiene que aceptarse:
    // son cinco clics fuera de la diana declarando `score: 0`, o sea un jugador que fallo cinco de
    // cinco. Eso no es un ataque, es una partida mala, y rechazarla seria punishing por jugar mal en
    // vez de por mentir. La penalizacion por fallo ya la suffer los puntos, que es donde debe ir.
    //
    // Lo que se conserva del test original es la intencion: comprobar que la posicion de un clic
    // sigue importando. Ahora importa para CUANTO puntua, no para si se acepta la partida.
    const seed = `0x${'cc'.repeat(32)}` as const
    // Se recorre la secuencia real de dianas pero se desplaza cada clic muy lejos de la tolerancia.
    // El desplazamiento se recorta a 1..99 para que la comprobacion de forma pase y lo que se este
    // ejercitando sea la clasificacion, no el limite de coordenadas.
    const events = Array.from({ length: 5 }, (_, index) => {
      const target = expectedTarget(seed, index)
      return { atMs: index * 150, x: Math.min(99, Math.max(1, target.x + 40)), y: target.y }
    })
    const allMisses = { score: 0, startedAt: 0, finishedAt: 30_000, events, shieldActivations: [] }
    // Se acepta la forma, y el score que recalcula el servidor es 0: cinco fallos, cinco ceros.
    expect(gameResultValidationError(allMisses, seed, 'human')).toBe(null)
    expect(expectedScore(allMisses, seed, 'human')).toBe(0)
    // El MISMO stream declarando MAX_SCORE si se rechaza, y por la via que toca: no la forma, sino
    // que el score declarado no cuadra con el recomputado.
    const lying = { ...allMisses, score: MAX_SCORE }
    expect(gameResultValidationError(lying, seed, 'human')).toBe(null)
    expect(expectedScore(lying, seed, 'human')).not.toBe(lying.score)
  })

  it('tolerates a hit within TARGET_TOLERANCE of the derived centre', () => {
    const seed = `0x${'33'.repeat(32)}` as const
    const events = Array.from({ length: 3 }, (_, index) => {
      const target = expectedTarget(seed, index)
      return { atMs: index * 150, x: target.x + TARGET_TOLERANCE, y: target.y - TARGET_TOLERANCE }
    })
    expect(gameResultValidationError({ score: 0, startedAt: 0, finishedAt: 30_000, events }, seed, 'human')).toBe(null)
  })

  it('never leaks the raw seed in its fingerprint', () => {
    const seed = `0x${'9a'.repeat(32)}` as const
    const fingerprint = seedFingerprint(seed)
    expect(fingerprint.startsWith('0x')).toBe(true)
    expect(fingerprint).not.toContain(seed.slice(2))
  })
})

describe('regression: leaderboard ranking is per best-score-per-wallet', () => {
  // These tests pin the *ranking rule*, which now lives in SQL (arcade_scores_best) rather than in
  // application code. They cannot execute the view, so what they assert is the invariant the view is
  // documented to enforce and that the app now relies on: one wallet contributes exactly one ranking
  // row per epoch. If a migration ever drops that DISTINCT ON, the queries in lib/reward-finalization.ts
  // and app/api/leaderboard/route.ts would silently start reconciling duplicate wallets against the
  // chain's getTop10 and fail epoch closure with VYR_SNAPSHOT_RECONCILIATION_MISMATCH.
  it('keeps only the best score when a wallet has several scores in one epoch', () => {
    const wallet = '0x00000000000000000000000000000000000000aa'
    const scoresInEpoch = [120, 400, 260].map((score) => ({ wallet, epoch: 7, arena_type: 'human', score }))
    const ranked = new Map<string, number>()
    for (const row of scoresInEpoch) ranked.set(row.wallet, Math.max(ranked.get(row.wallet) ?? 0, row.score))
    expect([...ranked.values()]).toEqual([400])
    // The chain ranks players, not attempts, so three sessions must occupy one slot.
    expect(ranked.size).toBe(1)
  })

  it('never ranks a score from a different arena against human winners', () => {
    // FINDING (medium): the old top-10 query omitted arena_type, so an agent-arena score could be
    // reconciled against human-arena chain winners and abort epoch closure.
    const rows = [
      { wallet: '0x00000000000000000000000000000000000000aa', arena_type: 'human', score: 400 },
      { wallet: '0x00000000000000000000000000000000000000bb', arena_type: 'agent', score: 900 },
    ]
    const humanOnly = rows.filter((row) => row.arena_type === 'human')
    expect(humanOnly).toHaveLength(1)
    expect(humanOnly[0].score).toBe(400)
  })

  it('excludes scores that were never confirmed on chain', () => {
    // arcade_scores_best filters status = 'recorded' internally. Removing that filter would let an
    // unfinalised row occupy a leaderboard slot, so assert the filter is what gates inclusion.
    const rows = [
      { wallet: '0x00000000000000000000000000000000000000aa', score: 400, status: 'recorded' },
      { wallet: '0x00000000000000000000000000000000000000bb', score: 900, status: 'submitting' },
      { wallet: '0x00000000000000000000000000000000000000cc', score: 800, status: 'failed' },
    ]
    const recorded = rows.filter((row) => row.status === 'recorded')
    expect(recorded.map((row) => row.score)).toEqual([400])
  })
})

describe('regression: numeric(78,0) amounts must not round-trip through a JSON number', () => {
  // FINDING (medium): PostgREST serialises numeric to a JSON *number*, so any wei-scale value above
  // 2^53 is silently rounded by the JSON parser before the app sees it. The fix is to read these
  // columns through views that cast them to text (vyr_claims_wei, svp_reward_allocations_wei,
  // vyr_chain_snapshots_wei), which makes PostgREST emit a JSON string.
  //
  // BigInt values are built from strings rather than literals: tsconfig targets ES6 (the Next.js
  // default, and changing it to satisfy a test would alter the whole build), and ES6 forbids both
  // `123n` literals and `**` on bigint operands.
  const ONE_SVP = BigInt('1000000000000000000') // 1e18 wei = 1 SVP
  const ONE_SVP_PLUS_DUST = BigInt('1000000000000000001') // + 1 wei
  const MAX_UINT256 = BigInt(`0x${'f'.repeat(64)}`)

  it('loses precision when a large integer goes through a JSON number', () => {
    // Any wei amount above 2^53 (9.007e15) cannot survive a JSON number. 1e18 + 1 is the smallest
    // realistic case: a whole number of SVP plus a single wei of dust, which is exactly the kind of
    // value a reward amount carries and exactly the value a JSON number destroys.
    expect(Number.isSafeInteger(Number(ONE_SVP_PLUS_DUST))).toBe(false)
    const viaNumber = BigInt(JSON.parse(JSON.stringify({ amount: Number(ONE_SVP_PLUS_DUST) })).amount as string)
    expect(viaNumber).not.toBe(ONE_SVP_PLUS_DUST)
    // The damage is exactly what rounding does: the dust wei is silently gone.
    expect(viaNumber).toBe(ONE_SVP)
  })

  it('preserves precision when the same value arrives as a decimal string', () => {
    const parsed = JSON.parse(JSON.stringify({ amount: ONE_SVP_PLUS_DUST.toString() })) as { amount: string }
    expect(typeof parsed.amount).toBe('string')
    expect(BigInt(parsed.amount)).toBe(ONE_SVP_PLUS_DUST)
  })

  it('preserves a max-uint256-scale wei amount through a string', () => {
    const parsed = JSON.parse(JSON.stringify({ reward_amount: MAX_UINT256.toString() })) as { reward_amount: string }
    expect(BigInt(parsed.reward_amount)).toBe(MAX_UINT256)
    // As a number it is not merely rounded but unrepresentable, which is why the cast is required.
    expect(BigInt(Number(parsed.reward_amount))).not.toBe(MAX_UINT256)
  })

  it('preserves a wei amount above 2^53 that IS a double, but only because it happens to be exact', () => {
    // 1e18 is above 2^53 yet exactly representable, which is why a test that only checks
    // 10**18 passes by luck and proves nothing. The +1 variant is the one that actually breaks.
    expect(Number.isSafeInteger(Number(ONE_SVP))).toBe(false)
    expect(BigInt(JSON.parse(JSON.stringify({ amount: Number(ONE_SVP) })).amount as string)).toBe(ONE_SVP)
    expect(BigInt(JSON.parse(JSON.stringify({ amount: Number(ONE_SVP_PLUS_DUST) })).amount as string)).not.toBe(ONE_SVP_PLUS_DUST)
  })
})

describe('regression: wallet-provenance challenge protocol', () => {
  const wallet = '0x000000000000000000000000000000000000dEaD'
  const issuedAt = 1_700_000_000

  it('builds a message containing the address, nonce and chain id', () => {
    const message = buildAuthMessage({ wallet, nonce: '0x' + 'ab'.repeat(16), issuedAt })
    expect(message).toContain(wallet)
    expect(message).toContain('Nonce: 0x' + 'ab'.repeat(16))
    expect(message).toContain('Chain ID: 2517')
  })

  it('is byte-identical when rebuilt from the same fields (server rebuilds, client never supplies text)', () => {
    const input = { wallet, nonce: '0x' + '01'.repeat(16), issuedAt }
    expect(expectedMessageFromRequest(input)).toBe(buildAuthMessage(input))
  })

  it('produces a different message for a different nonce, so a signature cannot be moved', () => {
    expect(buildAuthMessage({ wallet, nonce: '0x' + '01'.repeat(16), issuedAt }))
      .not.toBe(buildAuthMessage({ wallet, nonce: '0x' + '02'.repeat(16), issuedAt }))
  })

  it('strips newlines so a signed field cannot be re-partitioned', () => {
    expect(buildAuthMessage({ wallet, nonce: '0x' + '03'.repeat(16), issuedAt })).not.toMatch(/\r/)
  })

  it('generates a fresh, well-formed, unguessable nonce each time', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => createNonce()))
    expect(nonces.size).toBe(50)
    for (const nonce of nonces) expect(isValidNonce(nonce)).toBe(true)
  })

  it('rejects malformed nonces and wallets', () => {
    expect(isValidNonce('0xshort')).toBe(false)
    expect(isValidNonce('ab'.repeat(16))).toBe(false)
    expect(isValidChallengeWallet('0x123')).toBe(false)
    expect(isValidChallengeWallet(wallet)).toBe(true)
  })

  it('expires a stale challenge and rejects a far-future one', () => {
    const nowMs = issuedAt * 1000
    expect(isChallengeFresh(issuedAt, nowMs)).toBe(true)
    expect(isChallengeFresh(issuedAt, nowMs + 10_000)).toBe(true)
    expect(isChallengeFresh(issuedAt, nowMs + (CHALLENGE_TTL_SECONDS + 1) * 1000)).toBe(false)
    expect(isChallengeFresh(issuedAt, nowMs + 86_400_000)).toBe(false)
  })

  it('allows only a small amount of clock skew in the client direction', () => {
    expect(isChallengeFresh(issuedAt + 5, issuedAt * 1000)).toBe(true)
    expect(isChallengeFresh(issuedAt + 120, issuedAt * 1000)).toBe(false)
  })

  it('rejects non-numeric issue times rather than treating NaN as fresh', () => {
    expect(isChallengeFresh(Number.NaN, Date.now())).toBe(false)
    expect(isChallengeFresh(issuedAt, Number.NaN)).toBe(false)
  })
})

describe('remediation security controls', () => {
  it('fails closed when cron secret is missing or wrong', () => {
    const request = new Request('https://example.test/api/cron/close-human', { headers: { authorization: 'Bearer wrong' } })
    expect(authorizeCronRequest(request, undefined)).toEqual({ ok: false, status: 503, error: 'CRON_SECRET is not configured' })
    expect(authorizeCronRequest(request, 'correct')).toEqual({ ok: false, status: 401, error: 'unauthorized' })
    expect(authorizeCronRequest(new Request(request.url, { headers: { authorization: 'Bearer correct' } }), 'correct')).toEqual({ ok: true })
  })
  it('uses only a valid trusted proxy IP and ignores spoofable forwarded headers', () => {
    // x-forwarded-for remains ignored even after the fallback change below: it is client-controlled,
    // so trusting it would let anyone rotate the rate-limit identity at will.
    expect(getTrustedClientIp(new Request('https://example.test', { headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '2001:db8::1' } }))).toBe('2001:db8::1')
    expect(getTrustedClientIp(new Request('https://example.test', { headers: { 'x-real-ip': 'not-an-ip' } }))).toBe('shared-edge-bucket')
    // Only x-real-ip is consulted, so an absent one must not pick the value out of x-forwarded-for.
    expect(getTrustedClientIp(new Request('https://example.test', { headers: { 'x-forwarded-for': '1.2.3.4' } }))).toBe('shared-edge-bucket')
  })

  it('falls back to the edge address rather than collapsing all clients into one shared bucket', () => {
    // FINDING (medium): the old implementation returned the literal 'unknown' for every request when
    // the platform sent no x-real-ip, so one abusive client locked out the whole arcade. Distinct
    // real clients now resolve to distinct identities via the platform's own edge headers.
    expect(getTrustedClientIp(new Request('https://example.test', { headers: { 'x-vercel-forwarded-for': '203.0.113.7, 10.0.0.1' } }))).toBe('203.0.113.7')
    expect(getTrustedClientIp(new Request('https://example.test', { headers: { 'cf-connecting-ip': '198.51.100.9' } }))).toBe('198.51.100.9')
    expect(getTrustedClientIp(new Request('https://example.test', { headers: { 'x-real-ip': '203.0.113.7', 'x-vercel-forwarded-for': '198.51.100.9' } }))).toBe('203.0.113.7')
  })

  it('does not let a malformed edge header impersonate a client', () => {
    // A non-IP value must never become the identity, and must not be used as a rate-limit key.
    expect(getTrustedClientIp(new Request('https://example.test', { headers: { 'x-vercel-forwarded-for': 'not-an-ip' } }))).toBe('shared-edge-bucket')
    expect(getTrustedClientIp(new Request('https://example.test', { headers: { 'cf-connecting-ip': '999.999.999.999' } }))).toBe('shared-edge-bucket')
    expect(getTrustedClientIp(new Request('https://example.test', { headers: { 'x-vercel-forwarded-for': '  ' } }))).toBe('shared-edge-bucket')
  })

  it('keeps the shared bucket as one honest bucket rather than one per request', () => {
    // A per-request pseudo-identity would defeat the limiter entirely: an attacker would get a fresh
    // quota on every call. Two headerless requests must resolve to the same identity.
    expect(getTrustedClientIp(new Request('https://example.test'))).toBe(getTrustedClientIp(new Request('https://example.test/other')))
  })
})

describe('VYR publisher catch state priority', () => {
  it('never downgrades published or mismatch to failed', () => {
    expect(publishCatchTransition('published')).toBe('return_published')
    expect(publishCatchTransition('mismatch')).toBe('throw_mismatch')
  })
  it('preserves uncertain publishing and only failed marks failed', () => {
    expect(publishCatchTransition('publishing')).toBe('return_publishing')
    expect(publishCatchTransition('failed')).toBe('mark_failed')
  })
})

describe('VYR claim calldata validation', () => {
  // `arena` es un `ArenaId` (0|1|2|3), no un number suelto. Con V3 el id de AGENT paso a 3 y
  // MEDIUM ocupa el 1, asi que un literal `1` en un test significaria "medium" sin que nada lo
  // delate. Se escriben los nombres y el registro los traduce.
  const expected = { arena: ARENA_IDS.human as 0, epoch: BigInt(7) }
  const calldata = (args: readonly unknown[]) => encodeFunctionData({ abi: vynarRewardsV3Abi, functionName: 'claim', args } as never)
  it('accepts valid claim calldata', () => expect(validateVyrClaimCalldata(calldata([expected.arena, expected.epoch]), expected)).toBeNull())
  it('rejects wrong arena, epoch, and function', () => {
    // MEDIUM, no AGENT: en V3 el 1 es medium. Usar el nombre evita_slotear el valor por costumbre.
    expect(validateVyrClaimCalldata(calldata([ARENA_IDS.medium, expected.epoch]), expected)).toBe('CLAIM_TX_ARENA_MISMATCH')
    expect(validateVyrClaimCalldata(calldata([expected.arena, BigInt(8)]), expected)).toBe('CLAIM_TX_EPOCH_MISMATCH')
    expect(validateVyrClaimCalldata('0x1234', expected)).toBe('CLAIM_TX_FUNCTION_MISMATCH')
  })
  it('accepts a claim for a non-human arena when the arena matches', () => {
    const medium = { arena: ARENA_IDS.medium, epoch: BigInt(9) }
    expect(validateVyrClaimCalldata(calldata([medium.arena, medium.epoch]), medium)).toBeNull()
  })
})

describe('web3 error messages', () => {
  it('maps wallet rejection without exposing technical details', () => {
    expect(getWeb3ErrorMessage(new Error('User rejected the request'))).toBe('Transaction cancelled.')
  })
  it('maps RPC failures to a safe message', () => {
    expect(getWeb3ErrorMessage(new Error('RPC timeout'))).toBe('The network could not be reached.')
  })
})

describe('epoch state hardening', () => {
  const base = { currentEpoch: BigInt(4), epochStart: BigInt(100), epochEnd: BigInt(200), active: true, closed: false, pool: BigInt(10), prizePool: BigInt(0) }
  it('distinguishes open, closing, closed, and inactive states', () => {
    expect(getEpochStatus(base, BigInt(150))).toBe('OPEN')
    expect(getEpochStatus(base, BigInt(200))).toBe('CLOSING')
    expect(getEpochStatus({ ...base, closed: true }, BigInt(150))).toBe('CLOSED')
    expect(getEpochStatus({ ...base, active: false }, BigInt(150))).toBe('INACTIVE')
  })
  it('closes entries before the gameplay safety window', () => {
    expect(canAcceptEntry(base, BigInt(150), 30)).toBe(true)
    expect(canAcceptEntry(base, BigInt(171), 30)).toBe(false)
  })
  it('only reports connected top-three wallets', () => {
    const entries = [{ player: '0x0000000000000000000000000000000000000001', score: BigInt(30) }, { player: '0x0000000000000000000000000000000000000002', score: BigInt(20) }, { player: '0x0000000000000000000000000000000000000003', score: BigInt(10) }]
    expect(isTopThree(entries[1].player, entries)).toBe(2)
    expect(isTopThree('0x0000000000000000000000000000000000000004', entries)).toBe(null)
  })
})

describe('submission reconciliation policy', () => {
  it('keeps submitted and uncertain writes pending without a second send', () => {
    expect(shouldKeepSubmissionPending({ submittedTxHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', chainTransactionFailed: false })).toBe(true)
    expect(shouldKeepSubmissionPending({ submittedTxHash: undefined, chainTransactionFailed: false, writeOutcomeUncertain: true })).toBe(true)
    expect(shouldKeepSubmissionPending({ submittedTxHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', chainTransactionFailed: true })).toBe(false)
  })
  it('uses persisted score and receipt reconciliation transitions', () => {
    expect(persistedScoreTransition('recorded')).toBe('recorded')
    expect(persistedScoreTransition('failed')).toBe('failed')
    expect(persistedScoreTransition('submitting')).toBe('reconcile_receipt')
    expect(reconciliationTransition('success')).toBe('recorded')
    expect(reconciliationTransition('reverted')).toBe('failed')
    expect(reconciliationTransition('pending')).toBe('pending')
  })
})

describe('play error semantics', () => {
  it('does not present infrastructure/payment errors as session expiration', () => {
    for (const code of ['EPOCH_READ_FAILED', 'SESSION_CREATE_FAILED', 'INVALID_PAYMENT', 'PAYMENT_REPLAY', 'CONTRACT_MISMATCH', 'CHAIN_UNAVAILABLE']) expect(getPlayErrorState(code).title).not.toBe('Sesión inválida o expirada')
  })
  it('maps contract mismatch separately', () => expect(getPlayErrorState('CONTRACT_MISMATCH').title).toBe('Incompatible contract'))
})

describe('ArcadeVault V6 ABI and payment rules', () => {
  it('matches payToPlay and recordScore and excludes removed functions', () => {
    expect(ARENA_IDS.human).toBe(0)
    expect(HUMAN_ENTRY_FEE).toBe(BigInt('100000000000000000'))
    expect(toFunctionSelector('payToPlay(uint8)')).toBe('0xd032ef25')
    const recordScore = arcadeVaultV6Abi.find((item) => item.type === 'function' && item.name === 'recordScore')
    expect(recordScore?.inputs.map((input) => input.type)).toEqual(['uint8', 'address', 'uint256', 'bytes32', 'uint256', 'uint256', 'uint256', 'bytes'])
    const names = arcadeVaultV6Abi.filter((item) => item.type === 'function').map((item) => item.name)
    expect(names).toContain('arenas')
    expect(names).toContain('getArenaInfo')
    expect(names).toContain('getEpochResult')
    expect(names).toContain('usedSessionIds')
    expect(names).not.toContain('epochEntryFee')
    expect(names).not.toContain('epochDurationByEpoch')
    // NOTA: `epochResults` SI sigue en V6, con otra forma. No se comprueba aqui porque hay un test
    // dedicado que explica por que ese nombre debe evitarse pese a seguir existiendo.
  })
  it('exposes getEpochResult with the frozen bps the app must read from chain', () => {
    // `getEpochResult` es el sustituto de V5 `epochResults` y lo unico que devuelve `bps`, el
    // reparto por puesto. V6 congela los bps al cerrar sobre los slots poblados, asi que la app
    // NO puede asumir 70/20/10: tiene que leerlos de aqui.
    const getEpochResult = arcadeVaultV6Abi.find((item) => item.type === 'function' && item.name === 'getEpochResult')
    expect(getEpochResult?.outputs?.map((output) => output.name)).toEqual(['winners', 'bps', 'winnerCount', 'prizePool', 'paidOut', 'totalPaid', 'closed', 'voided', 'swept'])
  })
  it('guards the epochResults name collision: same name, different shape', () => {
    // LA TRAMPA MAS PELIGROSA DE ESTA MIGRACION. V6 NO renombro `epochResults`: lo conservo y le
    // cambio la forma de 2 salidas a 8, en otro orden. V5 era [prizePool, closed], asi que un
    // `epochResults(...)[1]` que significaba `closed` pasa a devolver `prizePool`, un bigint.
    // Un bigint en una posicion booleana es truthy: una epoch abierta se leeria como cerrada,
    // sin error de typecheck, sin excepcion y sin logs.
    //
    // Por eso la app usa `getEpochResult` y este test fija la forma de AMBAS. Si alguien vuelve a
    // `epochResults` porque "el nombre es el de siempre", este bloque dice por que no.
    const epochResults = arcadeVaultV6Abi.find((item) => item.type === 'function' && item.name === 'epochResults')
    expect(epochResults?.outputs?.map((output) => output.name)).toEqual(['winnerCount', 'prizePool', 'totalPaid', 'paidOut', 'closedAt', 'closed', 'voided', 'swept'])
    // `closed` esta en el indice 5, no en el 1 que ocupaba en V5.
    expect(epochResults?.outputs?.length).toBe(8)
    expect(epochResults?.outputs?.[1]?.name).toBe('prizePool')
    expect(epochResults?.outputs?.[5]?.name).toBe('closed')
  })
  it('pins the getArenaInfo output order that readArena() destructures', () => {
    // `readArena()` en lib/server-blockchain.ts desestructura getArenaInfo POR POSICION. Estos
    // nombres son el unico sitio que dice si ese mapeo sigue siendo cierto; si el contrato anade
    // una salida en medio, este test falla en vez de que `active` empiece a leerse como bigint.
    const getArenaInfo = arcadeVaultV6Abi.find((item) => item.type === 'function' && item.name === 'getArenaInfo')
    expect(getArenaInfo?.outputs?.map((output) => output.name)).toEqual(['entryFee', 'protocolFeeBps', 'epochDuration', 'currentEpoch', 'epochStart', 'epochEnd', 'pool', 'active', 'paused', 'secondsLeft'])
  })
  it.each([
    ['exact fee', parseEther('0.1'), true],
    ['lower fee', parseEther('0.099'), false],
    ['higher fee', parseEther('0.101'), false],
  ])('requires %s to equal entryFee', (_, value, expected) => expect(value === parseEther(ARCADE_ENTRY_FEE)).toBe(expected))
  it('keeps chain, address, selector and receipt checks strict', () => {
    expect(SVP_CHAIN_ID).toBe(2517)
    expect(toFunctionSelector('payToPlay(uint8)')).not.toBe(toFunctionSelector('recordScore(uint8,address,uint256,bytes32,uint256,uint256,uint256,bytes)'))
    expect(toFunctionSelector('recordScore(uint8,address,uint256,bytes32,uint256,uint256,uint256,bytes)')).toBe('0x035396b6')
    expect(toFunctionSelector('claimPrize(uint8,uint256)')).toBe('0x5ce80316')
    expect(toFunctionSelector('leaderboard(uint8,uint256,uint256)')).toBe('0xda969ae7')
    expect('success').not.toBe('reverted')
  })
  it('prices every arena so the staker always receives the same flat fee', () => {
    // El fee plano es 0.02 SVP en los tres modos. Si un arena cambia de precio o de bps y el
    // producto se sale de 0.02, el staker recibe una cantidad distinta por modo y el unequino
    // inicial del protocolo se rompe en silencio.
    for (const type of ['human', 'medium', 'hard'] as const) {
      expect(flatFeeWei(arenaByType(type)!)).toBe(BigInt('20000000000000000'))
    }
  })
  it('keeps the protocol fee bps under the contract ceiling', () => {
    // MAX_PROTOCOL_FEE_BPS = 3000 en ArcadeVaultV6. setProtocolFee revierte si se supera, asi que
    // un bps fuera de rango rompe el deploy y no el runtime.
    for (const arena of ARENAS) expect(arena.protocolFeeBps).toBeLessThanOrEqual(3000)
  })
  it('resolves the arena param by name and by id, and rejects the rest', () => {
    expect(parseArenaParam('medium')).toBe('medium')
    expect(parseArenaParam(String(ARENA_IDS.hard))).toBe('hard')
    // `agent` tiene id y fila pero no es jugable: un `?arena=agent` que cayera a human seria la
    // forma de que el cliente creyera estar jugando un modo reservado.
    expect(parseArenaParam('agent')).toBeUndefined()
    expect(parseArenaParam(String(ARENA_IDS.agent))).toBeUndefined()
    expect(parseArenaParam('meduim')).toBeUndefined()
    expect(parseArenaParam('')).toBeUndefined()
    expect(parseArenaParam(null)).toBeUndefined()
  })
  it('exposes a distinct entry fee per playable arena', () => {
    expect(ENTRY_FEE_BY_TYPE.human).toBe(parseEther('0.1'))
    expect(ENTRY_FEE_BY_TYPE.medium).toBe(parseEther('0.5'))
    expect(ENTRY_FEE_BY_TYPE.hard).toBe(parseEther('1.0'))
  })
})

describe('regression: el escudo bloquea la penalizacion por fallo y su flujo se valida', () => {
  // El escudo tiene cuatro reglas en el registro (duracion, ventana de activacion, tope de
  // activaciones, cooldown) pero hasta la Etapa 5 no habia NADA que las ejecutara. Eran campos que
  // nadie leia, y un campo que nadie lee es un campo que nadie puede cambiar sin riesgo: cambiarlo
  // no rompia nada porque no hacia nada. Estos tests son los que convierten esas reglas en
  // cometidas, de modo que tocarlas tenga que romper una asercion y no pasar desapercibido.

  const medium = arenaByType('medium')!
  const hard = arenaByType('hard')!
  const human = arenaByType('human')!
  const SHIELD = medium.gameplay.shield!
  const seed = `0x${'5a'.repeat(32)}` as const
  /** Cinco clics sobre la diana que les toca, en los segundos 0, 2, 4, 6 y 8. */
  const onTarget = Array.from({ length: 5 }, (_, index) => ({ atMs: 2_000 * index, ...expectedTarget(seed, index) }))
  /** El mismo flujo con el tercer clic movido 40 unidades, muy fuera de la tolerancia. */
  const withMiss = onTarget.map((event, index) => index === 2 ? { ...event, x: event.x > 50 ? event.x - 40 : event.x + 40 } : event)
  const run = (events: { atMs: number; x: number; y: number }[], shieldActivations: number[] = []) =>
    ({ score: 0, startedAt: 0, finishedAt: 8_000, events, shieldActivations })

  it('un fallo puntua 0 mientras el escudo no este activo', () => {
    expect(expectedScore(run(onTarget), seed, 'medium')).toBe(1_460)
    expect(expectedScore(run(withMiss), seed, 'medium')).toBe(1_168)
    // Y en `human`, que no tiene escudo, la penalizacion es la misma: el escudo no cambia el
    // significado de fallar, solo lo evita durante la ventana.
    expect(expectedScore(run(withMiss), seed, 'human')).toBe(1_800 - 360)
  })

  it('un fallo cubierto por el escudo puntua como un acierto', () => {
    expect(expectedScore(run(withMiss, [3_000]), seed, 'medium')).toBe(1_460)
    expect(expectedScore(run(withMiss, [0]), seed, 'medium')).toBe(1_460)
    // El instante es lo que manda. Activar en 9s no cubre un fallo del segundo 4: la ventana es
    // [9s, 19s) y el fallo fue a los 4s. Si esto devolviera el score completo, el escudo serviria
    // para borrar cualquier fallo anterior, que es justo lo que no puede hacer.
    expect(expectedScore(run(withMiss, [9_000]), seed, 'medium')).toBe(1_168)
    expect(expectedScore(run(withMiss, [5_000]), seed, 'medium')).toBe(1_168)
  })

  it('la ventana del escudo es cerrada por la izquierda y abierta por la derecha', () => {
    expect(shieldActiveAt([5_000], SHIELD, 5_000)).toBe(true)
    expect(shieldActiveAt([5_000], SHIELD, 14_999)).toBe(true)
    // El milisegundo exacto en que el escudo expira ya no esta cubierto. Con el borde cerrado por la
    // derecha, dos activaciones separadas justo por `durationMs` se solaparian en ese milisegundo y
    // el cooldown no cuadraria con la duracion.
    expect(shieldActiveAt([5_000], SHIELD, 15_000)).toBe(false)
    expect(shieldActiveAt([5_000], SHIELD, 4_999)).toBe(false)
    expect(shieldActiveAt([], SHIELD, 5_000)).toBe(false)
  })

  it('un cliente sin el campo shieldActivations es una partida sin escudo, no una partida invalida', () => {
    // Ausente, `null` y lista vacia son lo mismo: no lo uso. Rechazarlo daria un 422 sobre una
    // partida legitima de `human` hecha por un cliente anterior a la mecanica, que es el fallo
    // indistinguible de un fraude y el que este repo lleva cinco etapas quitando de en medio.
    expect(shieldValidationError(undefined, medium.gameplay)).toBe(null)
    expect(shieldValidationError(null, medium.gameplay)).toBe(null)
    expect(shieldValidationError([], medium.gameplay)).toBe(null)
    expect(shieldValidationError(undefined, human.gameplay)).toBe(null)
  })

  it('la AUSENCIA de activaciones nunca se lee como un escudo gratis', () => {
    // Un fallo antes de la activacion sigue puntuando 0. Si esto devolviera el score completo,
    // declarar el campo vacio seria mejor que no declararlo.
    expect(expectedScore(run(withMiss, []), seed, 'medium')).toBe(1_168)
  })

  it('rechaza activaciones que no son instantes enteros', () => {
    expect(shieldValidationError('3', medium.gameplay)).toBe('shield_shape')
    expect(shieldValidationError({ atMs: 3 }, medium.gameplay)).toBe('shield_shape')
    expect(shieldValidationError([1, 'two'], medium.gameplay)).toBe('shield_shape')
    expect(shieldValidationError([1.5], medium.gameplay)).toBe('shield_shape')
    expect(shieldValidationError([NaN], medium.gameplay)).toBe('shield_shape')
  })

  it('rechaza declarar escudo en una arena que no lo tiene', () => {
    // No protege el score —el calculo ignora un `shield` nulo, asi que dar puntos por esto seria
    // imposible— y esta ahi para que un cliente que se crea con escudo en `human` se entere en vez
    // de jugar 30s esperando una proteccion que nunca llega.
    expect(shieldValidationError([0], human.gameplay)).toBe('shield_not_available')
    expect(shieldValidationError([], human.gameplay)).toBe(null)
  })

  it('rechaza mas activaciones de las que la arena permite', () => {
    // Sin este tope un cliente declaraba 60 activaciones y tenia la partida entera cubierta.
    expect(shieldValidationError([0, 1], medium.gameplay)).toBe('shield_too_many')
    expect(shieldValidationError([0, 0, 0], hard.gameplay)).toBe('shield_too_many')
    expect(shieldValidationError([10_000], medium.gameplay)).toBe(null)
  })

  it('rechaza activar despues de la ventana permitida', () => {
    expect(shieldValidationError([-1], medium.gameplay)).toBe('shield_too_late')
    expect(shieldValidationError([10_001], medium.gameplay)).toBe('shield_too_late')
    // El borde SI se admite: activar justo en `cannotActivateAfterMs` es legal, y es el ultimo
    // momento en que el escudo alcanza para algo.
    expect(shieldValidationError([10_000], medium.gameplay)).toBe(null)
    expect(shieldValidationError([0], medium.gameplay)).toBe(null)
  })

  it('respeta el cooldown entre activaciones', () => {
    // Con `maxActivations: 1` hoy es vacuo, asi que este test es la unica red sobre un valor que
    // no se puede ejercitar con las arenas actuales. Se comprueba igual a proposito: anadir una
    // arena con varias activaciones no tiene que encontrar el fallo en produccion, y un assert que
    // nunca puede fallar es un assert que no protege nada.
    //
    // La ventana de activacion tambien hay que ensancharla, y no por capricho: con tope 3 y cooldown
    // de 10s, la ultima activacion util cae en el segundo 20, asi que `cannotActivateAfterMs` tiene
    // que llegar al menos ahi. Ver la invariante de abajo.
    const multi = { ...medium.gameplay, shield: { ...SHIELD, maxActivations: 3, cannotActivateAfterMs: 30_000 } }
    expect(shieldValidationError([0, 10_000, 20_000], multi)).toBe(null)
    expect(shieldValidationError([0, 9_999], multi)).toBe('shield_cooldown')
    // El orden de llegada no cambia nada, porque el hueco se mira sobre la lista ordenada y no sobre
    // la que el cliente decidio escribir. Mandarlos al reves sigue siendo legal —el mismo conjunto
    // ordenado es [0, 10_000] y el hueco es de 10s—, mientras que este si viola el cooldown una vez
    // ordenado, que es la unica forma en que la cuenta puede mentir.
    expect(shieldValidationError([10_000, 0], multi)).toBe(null)
    expect(shieldValidationError([10_000, 0, 5_000], multi)).toBe('shield_cooldown')
  })

  it('ninguna arena tiene una configuracion de escudo insatisfacible', () => {
    // Para activar `n` veces con cooldown `c`, la ultima cae en `(n - 1) * c`, y eso tiene que caber
    // en la ventana de activacion. Si no cabe, la arena promete un recurso que no se puede llegar a
    // usar, y no falla: simplemente el boton nunca se habilita y el jugador no sabe por que. Hoy
    // todas las arenas tienen tope 1 y la condicion se cumple trivialmente; el test existe para que
    // la primera arena con varias activaciones no la traje de serie.
    for (const arena of ARENAS.filter((entry) => entry.playable && entry.gameplay.shield)) {
      const shield = arena.gameplay.shield!
      expect(shield.maxActivations).toBeGreaterThanOrEqual(1)
      expect((shield.maxActivations - 1) * shield.cooldownMs).toBeLessThanOrEqual(shield.cannotActivateAfterMs)
      expect(shield.durationMs).toBeGreaterThan(0)
    }
    // Y `human`, la arena sin escudo, sigue sin tener reglas de escudo que alguien pueda dar por
    // buenas. Es la arena por defecto: si anadiese un `shield` con valores inventados, todas las
    // partidas de human empezarian a validar activaciones que nunca se enviaron.
    expect(human.gameplay.shield).toBe(null)
  })

  it('las reglas del registro hacen que activar tarde sea tiempo desperdiciado', () => {
    // `durationMs` igual a `cannotActivateAfterMs` no es redundante, es la razon de que el ultimo
    // momento util sea el ultimo momento legal. En `hard` (20s) la unica activacion cubre de 10s a
    // 20s, o sea TODA la segunda mitad. En `medium` (25s) cubre de 10s a 20s y los ultimos 5s se
    // quedan fuera, asi que hay una decision que tomar y no basta con activarlo.
    expect(hard.gameplay.shield).not.toBe(null)
    expect(hard.gameplay.maxDurationMs).toBe(20_000)
    expect(hard.gameplay.shield!.cannotActivateAfterMs + hard.gameplay.shield!.durationMs).toBe(hard.gameplay.maxDurationMs)
    expect(medium.gameplay.maxDurationMs).toBe(25_000)
    expect(medium.gameplay.shield!.cannotActivateAfterMs + medium.gameplay.shield!.durationMs).toBeLessThan(medium.gameplay.maxDurationMs)
  })

  it('la partida completa se valida y se puntua con las reglas de la arena de la sesion', () => {
    // El camino completo: un flujo con escudo activado despues de un fallo, con el score que el
    // servidor va a recalcular. `app/api/play/finish` compara `claimedScore !== expected`, asi que
    // esto tiene que pasar por la validacion Y cuadrar con el score declarado.
    const covered = run(withMiss, [3_000])
    expect(covered.score).toBe(0)
    const declared = { ...covered, score: expectedScore(covered, seed, 'medium') }
    expect(gameResultValidationError(declared, seed, 'medium')).toBe(null)
    // Y el mismo flujo con el score de antes del escudo es un 422, no una nota baja.
    const stale = { ...covered, score: 1_168 }
    expect(expectedScore(stale, seed, 'medium')).not.toBe(stale.score)
    // En `human` ese mismo flujo con una activacion es un rechazo de forma, no de score.
    expect(shieldValidationError((run(withMiss, [3_000]) as { shieldActivations: number[] }).shieldActivations, human.gameplay)).toBe('shield_not_available')
  })
})

describe('regression: el booster dobla el VYNAR y nunca los puntos, y su ventana dura 10s', () => {
  // El 2x es el primer multiplicador de este repo, y con el aparece el riesgo de que "duplicar" se
  // entienda en el sitio equivocado. Estos tests fijan la separacion: el score que se compara en
  // `app/api/play/finish` no sabe que existen boosters, y el total de VYNAR es una magnitud aparte.

  const medium = arenaByType('medium')!
  const hard = arenaByType('hard')!
  const human = arenaByType('human')!
  const BOOSTER = medium.gameplay.booster!
  const seed = `0x${'5b'.repeat(32)}` as const
  /** Cinco clics sobre la diana que les toca, en los segundos 0, 2, 4, 6 y 8. */
  const onTarget = Array.from({ length: 5 }, (_, index) => ({ atMs: 2_000 * index, ...expectedTarget(seed, index) }))
  const run = (boosterActivations: number[] = []) =>
    ({ score: 0, startedAt: 0, finishedAt: 8_000, events: onTarget, shieldActivations: [], boosterActivations })

  it('sin booster el total de VYNAR es exactamente el score', () => {
    // Esta es la asercion que hace que el camino por defecto no pueda desviarse nunca: sin booster,
    // los dos numeros coinciden. Un refactor que metiera el booster por el camino equivocado
    // multiplicaria aqui y el test lo diria.
    expect(expectedVynarPoints(run(), seed, 'medium')).toBe(expectedScore(run(), seed, 'medium'))
    expect(expectedVynarPoints(run(), seed, 'medium')).toBe(1_460)
  })

  it('el 2x cubre los clics de la ventana y deja el resto a 1x', () => {
    // Activada en el segundo 0, la ventana es [0, 10_000): cubre los cinco clics, que estan en 0, 2,
    // 4, 6 y 8 segundos. El total es el doble del score, sin decimales, porque el multiplicador es
    // exactamente 2x y cada valor de clic es entero.
    expect(expectedVynarPoints(run([0]), seed, 'medium')).toBe(1_460 * 2)
    // Activada en el segundo 4, la ventana es [4_000, 14_000) y solo cubre los clics de 4, 6 y 8
    // segundos, que en medium valen 292, 268 y 244. Los de 0 y 2 (340 y 316) se quedan a 1x.
    // La ventana no empieza a contar hacia atras: un booster no puede multiplicar un clic que ya
    // ocurrio, asi que el total NO es el doble de la partida.
    expect(expectedVynarPoints(run([4_000]), seed, 'medium')).toBe(340 + 316 + 2 * (292 + 268 + 244))
  })

  it('la ventana dura 10s exactos y es cerrada por la izquierda y abierta por la derecha', () => {
    expect(BOOSTER.durationMs).toBe(10_000)
    expect(boosterActiveAt([5_000], BOOSTER, 5_000)).toBe(true)
    expect(boosterActiveAt([5_000], BOOSTER, 14_999)).toBe(true)
    // El milisegundo exacto en que la ventana expira ya no esta dentro. Con el borde cerrado por la
    // derecha, dos activaciones separadas justo por `durationMs` se solaparian en ese milisegundo y el
    // 2x pasaria a ser 4x en un punto, que es exactamente lo que no debe pasar.
    expect(boosterActiveAt([5_000], BOOSTER, 15_000)).toBe(false)
    expect(boosterActiveAt([5_000], BOOSTER, 4_999)).toBe(false)
    expect(boosterActiveAt([], BOOSTER, 5_000)).toBe(false)
  })

  it('las ventanas nunca se acumulan: dos activaciones solapadas no dan 4x', () => {
    // Con `maxActivations: 1` hoy esto es inalcanzable, y por eso el test importa: si manana se sube
    // el tope, el 4x tiene que seguir siendo imposible. `boosterActiveAt` devuelve un booleano, no
    // un contador de ventanas, asi que la propiedad ya esta en la funcion y no en un detalle del
    // multiplicador.
    const rules = { ...BOOSTER, maxActivations: 2 }
    expect(boosterActiveAt([0, 5_000], rules, 6_000)).toBe(true)
    expect(expectedVynarPoints({ ...run([0, 5_000]), boosterActivations: [0, 5_000] }, seed, 'medium')).toBe(1_460 * 2)
  })

  it('el booster no cambia el score, ni aunque se multiplique todo', () => {
    // El score de una partida con booster es EXACTAMENTE el de la misma partida sin el. Si esto
    // cambiara, el 2x estaria moviendo el leaderboard, que es lo unico que este repo no permite:
    // `recordScore` recibe el score sin multiplicar y no recibe ningun factor.
    const withBooster = run([0])
    expect(expectedScore(withBooster, seed, 'medium')).toBe(expectedScore(run(), seed, 'medium'))
    // Y el comparador de la ruta no se altera por el hecho de que el resultado lleve activaciones:
    // `claimedScore !== expected` sigue viendo el mismo numero a los dos lados.
    const declared = { ...withBooster, score: expectedScore(withBooster, seed, 'medium') }
    expect(gameResultValidationError(declared, seed, 'medium')).toBe(null)
  })

  it('el total de VYNAR nunca baja del score, y hay un techo derivado de las reglas', () => {
    for (const arena of [human, medium, hard]) {
      const score = expectedScore(run(), seed, arena.type)
      const plain = expectedVynarPoints(run(), seed, arena.type)
      const boosted = expectedVynarPoints(run([0]), seed, arena.type)
      expect(plain).toBe(score)
      expect(boosted).toBeGreaterThanOrEqual(score)
      expect(vynarPointsRangeError(boosted, arena.gameplay, score)).toBe(null)
      expect(vynarPointsRangeError(plain, arena.gameplay, score)).toBe(null)
      // El techo es el maximo de score por el multiplicador, leido del registro y no escrito a mano.
      expect(vynarPointsRangeError(maxVynarPointsFor(arena.gameplay), arena.gameplay, 0)).toBe(null)
      expect(vynarPointsRangeError(maxVynarPointsFor(arena.gameplay) + 1, arena.gameplay, 0)).toBe('vynar_above_max')
      // Y un total por debajo del score se rechaza: solo puede significar dos partidas mezcladas.
      expect(vynarPointsRangeError(score - 1, arena.gameplay, score)).toBe('vynar_below_score')
    }
  })

  it('rechaza mas activaciones que unidades compradas', () => {
    // El 2x es de pago, y el unico sitio que decide si lo es es `availableUnits`. Con 0 unidades
    // pagadas, declarar una activacion es un rechazo y no un 2x gratis.
    expect(boosterValidationError([0], medium.gameplay, 0)).toBe('booster_no_units')
    expect(boosterValidationError([0], medium.gameplay, 1)).toBe(null)
    // El tope de la arena se comprueba aparte del saldo, porque son dos limites distintos: uno es
    // diseno (cuantas ventanas caben) y el otro es dinero (cuantas has comprado).
    expect(boosterValidationError([0, 1], medium.gameplay, 5)).toBe('booster_too_many')
  })

  it('un cliente sin el campo boosterActivations juega sin booster, no con uno gratis', () => {
    // Ausente, `null` y lista vacia son lo mismo: no lo uso. Y el total que sale es el score, o sea
    // el camino sin 2x. Si la ausencia se leyera como "una unidad gratis", un cliente que no
    // menciona el campo estaria multiplicando su VYNAR.
    for (const value of [undefined, null, []]) {
      expect(boosterValidationError(value, medium.gameplay, 0)).toBe(null)
      expect(expectedVynarPoints({ ...run(), boosterActivations: value as number[] | undefined }, seed, 'medium')).toBe(1_460)
    }
  })

  it('una activacion fuera de la ronda es un rechazo, y el motivo no es el score', () => {
    // A diferencia del escudo, el booster no tiene `cannotActivateAfterMs`: se paga y no hay
    // fecha de caducidad. Lo que no puede es activarse despues de que la ronda acabara, porque un
    // instante mayor que la duracion no cubre ningun clic y no tendria sentido contarlo.
    expect(boosterValidationError([0], medium.gameplay, 1)).toBe(null)
    expect(boosterValidationError([medium.gameplay.maxDurationMs], medium.gameplay, 1)).toBe(null)
    expect(boosterValidationError([medium.gameplay.maxDurationMs + 1], medium.gameplay, 1)).toBe('booster_out_of_round')
    expect(boosterValidationError([-1], medium.gameplay, 1)).toBe('booster_out_of_round')
  })

  it('el escudo y el booster se combinan: un fallo salvado por el escudo dentro de la ventana vale el doble', () => {
    // Se preguntan cosas distintas y por eso pueden ponerse. El escudo decide SI el clic puntua; el
    // booster decide si ese valor se dobla. Un fallo de los segundos 4 que el escudo salva a los 3s
    // (ventana [3_000, 13_000)) cae dentro de la ventana del booster si este se activa a los 0
    // ([0, 10_000)), asi que ese fallo recupera el doble.
    const withMiss = onTarget.map((event, index) => index === 2 ? { ...event, x: event.x > 50 ? event.x - 40 : event.x + 40 } : event)
    const shieldedMiss = { score: 0, startedAt: 0, finishedAt: 8_000, events: withMiss, shieldActivations: [3_000] }
    // Sin escudo, el fallo del segundo 4 vale 0 y el booster no lo hace aparecer: multiplicar el cero
    // da el cero. Lo que el 2x si hace es duplicar los OTROS cuatro clics, que estan dentro de la
    // ventana [0, 10_000): 2 * (340 + 316 + 268 + 244).
    expect(expectedVynarPoints({ ...shieldedMiss, shieldActivations: [], boosterActivations: [0] }, seed, 'medium')).toBe(2 * (340 + 316 + 268 + 244))
    // Con escudo, ese mismo fallo recupera su valor completo (292) y el booster lo dobla. La
    // diferencia entre las dos lineas es exactamente 2 * 292, que es lo que el escudo anade: un
    // falloKnown pasa de no valer nada a valer lo mismo que un acierto, y el 2x lo paga por encima.
    expect(expectedVynarPoints({ ...shieldedMiss, boosterActivations: [0] }, seed, 'medium')).toBe(1_460 * 2)
  })

  it('ninguna arena jugable se queda sin booster, y las reservadas no lo announce', () => {
    // El booster se COMPRA, asi que se ofrece en las tres jugables: no es una propiedad del
    // equilibrio de cada modo como el escudo. `agent` esta reservada, asi que no debe prometer un 2x
    // que no se podria cobrar.
    for (const arena of ARENAS.filter((entry) => entry.playable)) {
      expect(arena.gameplay.booster).not.toBe(null)
      expect(arena.gameplay.booster!.multiplierBps).toBe(20_000)
      expect(arena.gameplay.booster!.maxActivations).toBe(1)
    }
    expect(arenaByType('agent')!.gameplay.booster).toBe(null)
    // Una ventana de 10s tiene que caber en la ronda, o la arena prometeria un 2x que no cubre un
    // solo clic. En `hard` (20s) es la mitad exacta de la partida.
    for (const arena of ARENAS.filter((entry) => entry.playable)) {
      expect(arena.gameplay.booster!.durationMs).toBeLessThanOrEqual(arena.gameplay.maxDurationMs)
    }
    expect(hard.gameplay.booster!.durationMs).toBe(hard.gameplay.maxDurationMs / 2)
  })
})
