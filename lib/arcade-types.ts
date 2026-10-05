import type { Address, Hex } from 'viem'

export type SessionStatus = 'created' | 'paid' | 'active' | 'submitting' | 'recorded' | 'failed' | 'expired'
export type ScoreStatus = 'submitting' | 'recorded' | 'failed'

// Los ids numericos viven en lib/arcade-arenas.ts (ARENA_IDS) y deben coincidir con
// `enum ArenaType` de ArcadeVaultV6: HUMAN=0, MEDIUM=1, HARD=2, AGENT=3. OJO: AGENT
// pasa de 1 a 3, asi que un id persistido que significara `agent` ahora significa `medium`.
// `agent` se conserva porque la columna `arena_type` de la BD ya lo contiene, pero no es
// jugable: no se activa con `setArenaActive` hasta que exista el modo.
export type ArenaType = 'human' | 'medium' | 'hard' | 'agent'

export type ArcadeSession = {
  arena: ArenaType
  sessionId: string
  wallet: Address
  paymentId: string
  epoch: bigint
  gameSeed: Hex
  status: SessionStatus
  score: number | null
  expiresAt: string
}

export type GameplayEvent = { atMs: number; x: number; y: number }
/**
 * Lo que el cliente declara al terminar la ronda.
 *
 * `events` son CLICS, no aciertos: cada uno lleva su `atMs` y donde se hizo. El servidor decide si
 * cada clic fue acierto comparandolo con la diana que le toca por indice (la que deriva de
 * `gameSeed`), asi que el cliente no puede declararse un acierto donde fallo. Un clic que cae
 * fuera de la tolerancia puntua 0, y esa es la penalizacion que el escudo bloquea.
 *
 * `shieldActivations` son los `atMs` de cada activacion del escudo, en orden. Vacio en las arenas
 * sin escudo. El instante importa, no el orden: es lo que permite comprobar que un fallo anterior
 * a la activacion NO queda cubierto por ella.
 *
 * `boosterActivations` son los `atMs` de cada activacion de booster, y van por el mismo camino que
 * los del escudo: el instante es lo que delimita la ventana de 10s del 2x. Lo que cambia es lo que
 * afecta: el escudo toca el SCORE y el booster solo el VYNAR, asi que este campo no puede alterar un
 * ranking aunque se declame mal. Ausente o `null` significa "no lo uso", nunca "uno gratis" —un
 * cliente anterior a la mecanica tiene que poder seguir terminando su ronda.
 *
 * Opcional en el tipo, a diferencia de `shieldActivations`, y no por descuido: aqui la ausencia es
 * un valor de cable legitimo y frecuente (todo cliente anterior a la mecanica), mientras que en el
 * escudo es un caso de transicion que ya no ocurre porque todos los clientes lo envian. Declararlo
 * requerido obligaria a los tests a escribir `boosterActivations: []` en cada objeto solo para
 * satisfacer al compilador, y ese ruido esconde justo lo que el campo significa.
 */
export type GameResult = { score: number; startedAt: number; finishedAt: number; events: GameplayEvent[]; shieldActivations: number[]; boosterActivations?: number[] }
export type BlockchainTransaction = { hash: Hex; status: 'submitted' | 'confirmed' | 'failed' }
export type LeaderboardEntry = { wallet: Address; score: string; epoch: string; txHash: Hex | null; createdAt: string }

// `BOOSTER_UNAVAILABLE` esta separado de `INVALID_SCORE` a proposito, y no por granularidad. Un 409
// por falta de unidades es una carrera o un saldo agotado: el jugador hizo una partida valida y no
// hay booster que gastar. Un `INVALID_SCORE` diria que la partida era invalida, que es un juicio
// distinto sobre un resultado que era correcto. Colapsarlos en un codigo hizo que el mismo 409
// significara "no tienes saldo" y "tu intencion es illegal" segun quien lo mirara.
export type ApiErrorCode = 'INVALID_JSON' | 'SESSION_CONFLICT' | 'INVALID_PAYMENT' | 'PAYMENT_PENDING' | 'PAYMENT_REPLAY' | 'SESSION_NOT_FOUND' | 'SESSION_EXPIRED' | 'INVALID_SCORE' | 'BOOSTER_UNAVAILABLE' | 'RATE_LIMITED' | 'CHAIN_UNAVAILABLE' | 'INTERNAL_ERROR' | 'PAYMENT_VERIFY_FAILED' | 'PAYMENT_PERSISTENCE_FAILED' | 'EPOCH_READ_FAILED' | 'SESSION_CREATE_FAILED' | 'CONTRACT_MISMATCH' | 'EPOCH_CLOSED'
// AUDIT FIX: wallet-provenance codes. UNAUTHENTICATED and FORBIDDEN are what the per-wallet read
// endpoints now return instead of silently serving another address's data, and INVALID_WALLET /
// AUTH_UNAVAILABLE / INVALID_CHALLENGE / CHALLENGE_UNAVAILABLE / SIGN_IN_UNAVAILABLE cover the
// sign-in handshake. Kept deliberately coarse: no code distinguishes "nonce unknown" from
// "signature wrong", because that would let a caller probe which nonces exist.
export type AuthErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_WALLET' | 'AUTH_UNAVAILABLE' | 'INVALID_CHALLENGE' | 'CHALLENGE_UNAVAILABLE' | 'SIGN_IN_UNAVAILABLE'

export function apiError(code: ApiErrorCode | AuthErrorCode, message: string, status: number, requestId: string) {
  return Response.json({ error: { code, message }, requestId }, { status })
}
