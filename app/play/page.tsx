'use client'

import Link from 'next/link'
import { Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import { formatUnits, type Hex } from 'viem'
import { useAccount, useChainId, useConnect, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { ArrowLeft, Loader2, WalletCards } from 'lucide-react'
import { WalletProvider } from '@/components/wallet-provider'
import { ArenaTabs } from '@/components/arena-tabs'
import { getPlayErrorState, getWeb3ErrorMessage } from '@/lib/play-errors'
import { arcadeVaultV6Abi, arcadeVaultV6Address } from '@/lib/arcade-vault-v6-abi'
import { ARCADE_ENTRY_CUTOFF_SECONDS, SVP_CHAIN_ID } from '@/lib/arcade-config'
import { classifyClicks, expectedScore, expectedTarget, shieldActiveAt } from '@/lib/score-validation'
import { arenaByType, parseArenaParam, type ArenaConfig, type ArenaType } from '@/lib/arcade-arenas'
import { isPaymentStateBlocking } from '@/lib/payment-epoch'

type Mode = 'idle' | 'payment' | 'game' | 'submitting' | 'result' | 'error'

/**
 * Deduce la arena de la URL y la fija para toda la partida.
 *
 * `?arena=` acepta el nombre (`medium`) y el id numerico (`1`), y `parseArenaParam` rechaza lo que
 * no sea jugable, includedo `agent`. Sin el parametro cae a `human`. La invalidacion no cae a
 * `human`: un `?arena=inventado` es un 404 de la pagina, no una compra por el modo equivocado.
 *
 * UNA VEZ HAY SESION, EL MODO SE CONGELA en el que devolvio el servidor (`data.arena`) y la URL
 * deja de mandar. No es decoracion, es la garantia de que las reglas del cliente y las del
 * servidor sean las mismas:
 *
 *   - El servidor valida con `arenaByType(session.arena)`, no con lo que llegue en el request
 *     (app/api/play/finish:45). La sesion es lo unico que el cliente no controla.
 *   - Si el clienteSIGUIERA la URL, bastaria con que el jugador abriese `/play?arena=human`
 *     mientras su sesion era de `hard`: el cliente firmaria con la formula de human (bonus 10,
 *     decaimiento 30s) y el servidor recomputaria con la de hard (bonus 15, decaimiento 15s).
 *     El 422 diria 'invalid score' sobre una partida perfectamente legitima, sin forma de
 *     distinguirlo de un fraude.
 *   - La divergencia tampoco se puede colar por la sesion: `/api/play` devuelve `arena` y
 *     `arenaId` explicitos, y el trigger `arcade_sessions_arena_matches_payment` obliga a que el
 *     modo de la sesion sea el del pago.
 *
 * `ARENA.gameplay` y el `gameplay` que `/api/play` devuelve vienen del MISMO registro
 * (`lib/arcade-arenas.ts`), asi que no pueden discrepar entre si. Lo que si puede divergir es el
 * modo, y por eso el modo se toma de la sesion. No "optimizar" esta pagina para leer las reglas
 * de la respuesta: hacen falta antes de tener sesion, para derivar el primer objetivo.
/** The seed the server replay-checks hits against; anything else is treated as absent. */
function isHexSeed(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value)
}

const PAYMENT_KEY = 'verityarcade.payment'
const LEGACY_PAYMENT_KEY = 'verityarcade.paymentTx'

type StoredPayment = { tx: Hex; arena: ArenaType }

/**
* El tx pendiente se guarda CON su modo, no solo el hash.
 * Antes se guardaba `verityarcade.paymentTx = <hash>` a secas. Al recargar en `/play?arena=medium`
 * tras haber pagado una entrada de `human`, la recuperacion reintentaba abrir una sesion de medium
 * con un pago de human. El servidor lo rechaza: el trigger `arcade_sessions_arena_matches_payment`
 * no permite que el modo de la sesion difiera del del pago. Asi que no se cobraba dos veces ni se
 * perdia el dinero, pero el jugador veia un 409 sin relacion aparente con el pago que si que hizo.
 * Guardando el par, la recuperacion pide el modo por el que realmente se pago.
 *
 * Se sigue leyendo la clave vieja, que solo tenia el hash: ese caso no puede saber en que modo se
 * pago y cae a `human`, que es exactamente lo que hacia antes del cambio. Se borra al consumirse,
 * para que un pago viejo no pueda reaparecer mas tarde.
 */
function writeStoredPayment(tx: Hex, arena: ArenaType) { try { sessionStorage.setItem(PAYMENT_KEY, JSON.stringify({ tx, arena })) } catch { /* storage bloqueado o lleno: se pierde la recuperacion, no el pago */ } }
function clearStoredPayment() { try { sessionStorage.removeItem(PAYMENT_KEY); sessionStorage.removeItem(LEGACY_PAYMENT_KEY) } catch { /* idem */ } }
function readStoredPayment(): StoredPayment | null {
  try {
    const raw = sessionStorage.getItem(PAYMENT_KEY) ?? sessionStorage.getItem(LEGACY_PAYMENT_KEY)
    if (!raw) return null
    // Formato viejo: el hash a secas, sin modo. Solo human es una apuesta correcta, porque era el
    // unico modo jugable cuando se escribia.
    if (raw.startsWith('0x')) return isHexSeed(raw) ? { tx: raw, arena: 'human' } : null
    const parsed = JSON.parse(raw) as { tx?: unknown; arena?: unknown }
    if (!isHexSeed(parsed.tx)) return null
    const arena = parseArenaParam(typeof parsed.arena === 'string' ? parsed.arena : null)
    return arena ? { tx: parsed.tx, arena } : null
  } catch { return null }
}

function PlayRoom() {
  const searchParams = useSearchParams()
  const { address, isConnected } = useAccount()
  // Modo pedido por la URL. `parseArenaParam` acepta nombre (`medium`) o id numerico (`1`) y
  // devuelve undefined para lo que no sea jugable, `agent` incluido.
  const requested = searchParams.get('arena')
  const requestedArena = parseArenaParam(requested)
  // Un `?arena=` presente pero no jugable es un ERROR, no una invitacion a jugar en human: caer al
  // default cobraria 0.1 SVP por una partida que el jugador pidio en otro modo. Se bloquea la
  // entrada abajo en `entryOpen` y la pagina lo dice.
  const arenaInvalid = requested !== null && requestedArena === undefined
  // Modo congelado por la sesion. Ver el doc de arriba: mientras exista, la URL deja de mandar.
  const [sessionArena, setSessionArena] = useState<ArenaType | null>(null)
  const ARENA: ArenaConfig = arenaByType(sessionArena ?? requestedArena ?? 'human')!
  const chainId = useChainId()
  const { connect, connectors } = useConnect()
  const { switchChainAsync } = useSwitchChain()
  const { writeContract, data: hash, isPending: signing } = useWriteContract()
  // FINDING (critical, esta migracion): antes se leia el getter `arenas` por indice y en V6 ese
  // getter pasa de 9 salidas a 11. `active` estaba en el indice 7 y ahora esta en el 9, porque
  // en medio se insertaron `totalPaid` y `maxEntries`. `arenas(...)[7]` seguiria compilando y
  // devolveria un bigint, y `!bigint` solo es true cuando vale 0: `entryOpen` quedaria cerrado
  // casi siempre. Se usa `getArenaInfo`, que no solapa con esas dos salidas, y se desestructura
  // por posicion con nombres locales porque viem no conserva los nombres del ABI (nota larga en
  // lib/server-blockchain.ts).
  // getArenaInfo: [entryFee, protocolFeeBps, epochDuration, currentEpoch, epochStart, epochEnd,
  // pool, active, paused, secondsLeft]
  const { data: rawArena } = useReadContract({ address: arcadeVaultV6Address, abi: arcadeVaultV6Abi, functionName: 'getArenaInfo', args: [ARENA.id], query: { enabled: Boolean(arcadeVaultV6Address), refetchInterval: 30_000, staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } })
  const arena = useMemo(() => {
    if (!rawArena) return undefined
    const [entryFee, , , , , epochEnd, , active, paused] = rawArena
    return { entryFee, epochEnd, active, paused }
  }, [rawArena])
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash })
  const [serverNow, setServerNow] = useState(() => Math.floor(Date.now() / 1000))
  const entrySecondsRemaining = arena ? Math.max(0, Number(arena.epochEnd) - serverNow) : null
  // FINDING (high, remediated): the client gated entry at 30s remaining while
  // app/api/play/route.ts rejects anything below ARCADE_ENTRY_CUTOFF_SECONDS (300). Players in that
  // window paid 0.1 SVP and were then refused with 409 EPOCH_CLOSED. The client now uses the same
  // cutoff constant, so the gate can no longer disagree with the server.
  const entryOpen = Boolean(arena?.active && !arena.paused && !arenaInvalid && entrySecondsRemaining !== null && entrySecondsRemaining >= ARCADE_ENTRY_CUTOFF_SECONDS)
  const [mode, setMode] = useState<Mode>('idle')
  const [sessionId, setSessionId] = useState('')
  const [score, setScore] = useState(0)
  const [seconds, setSeconds] = useState(30)
  const [gameSeed, setGameSeed] = useState<Hex | null>(null)
  const [target, setTarget] = useState({ x: 50, y: 50 })
  const [txHash, setTxHash] = useState('')
  const [paymentSubmitted, setPaymentSubmitted] = useState(false)
  const paymentState = mode === 'payment' && paymentSubmitted ? 'PAYMENT_PENDING' : mode === 'game' ? 'PLAYING' : mode === 'submitting' ? 'SUBMITTING' : mode === 'result' ? 'READY_TO_PLAY' : mode === 'error' && txHash ? 'ERROR_REQUIRES_ACTION' : 'IDLE'
  const [startedAt, setStartedAt] = useState(0)
  const [events, setEvents] = useState<{ atMs: number; x: number; y: number }[]>([])
  // Instantes (`atMs` de la ronda) en los que se activo el escudo. Es el mismo array que se envia
  // al servidor: no hay una version "bonita" para la pantalla y otra para el calculo, porque
  // entonces el numero que se ve y el que se paga sale de dos fuentes distintas.
  const [shieldActivations, setShieldActivations] = useState<number[]>([])
  // Acierto o fallo del ULTIMO clic, para pintar la diana. Antes esto no hacia falta porque no
  // existia el fallo: `hitTarget` recibia la posicion de la diana, asi que todo clic acertaba y no
  // habia nada que comunicar. `null` es "no haviously ningun clic todavia".
  const [outcome, setOutcome] = useState<'hit' | 'miss' | null>(null)
  const eventsCountRef = useRef(0)
  const lastHitAtRef = useRef(-Infinity)
  // El area de juego mide su caja para traducir un clic a coordenadas 0..100. Sin el ref habria
  // que estimar el alto en pixeles, y la tolerancia de acierto (2 en `hard`) se comeria el error.
  const playfieldRef = useRef<HTMLDivElement | null>(null)
  // Monotonic anchor for the epoch countdown. FINDING (medium, remediated): the countdown was
  // driven straight off Date.now(), so a user clock adjustment mid-session could rewind or skip the
  // entry gate. performance.now() is monotonic and immune to wall-clock changes.
  const clockAnchorRef = useRef({ perf: 0, wall: 0 })
  // FINDING (medium, remediated): the stored-payment effect re-ran on every `mode` transition back
  // to idle, so a permanently failing payment hash was retried forever. One attempt per page load.
  const paymentRecoveryAttemptedRef = useRef(false)
  const [errorState, setErrorState] = useState({ title: '', message: '', action: '' })

  function parsePlayError(data: unknown) {
    const error = typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'object' && data.error !== null ? data.error : null
    const code = error && 'code' in error ? String(error.code) : undefined
    const message = error && 'message' in error ? String(error.message) : undefined
    return getPlayErrorState(code, message)
  }

  function reanchorClock() { clockAnchorRef.current = { perf: performance.now(), wall: Math.floor(Date.now() / 1000) } }
  function monotonicServerNow() { const anchor = clockAnchorRef.current; return anchor.wall + Math.floor((performance.now() - anchor.perf) / 1000) }
  useEffect(() => {
    reanchorClock()
    const timer = window.setInterval(() => setServerNow(monotonicServerNow()), 1000)
    return () => window.clearInterval(timer)
    // Re-anchor on every fresh chain reading; the wall clock is only trusted at that instant.
  }, [arena])
  useEffect(() => { if (isSuccess && mode === 'payment' && hash && chainId === SVP_CHAIN_ID) void requestPlay(hash, ARENA.type) }, [isSuccess, mode, hash, chainId])
  useEffect(() => { const stored = readStoredPayment(); if (!isConnected || mode !== 'idle' || paymentRecoveryAttemptedRef.current || !stored) return; paymentRecoveryAttemptedRef.current = true; setPaymentSubmitted(true); setMode('payment'); void requestPlay(stored.tx, stored.arena) }, [isConnected, mode])
  // Este efecto estaba DUPLICADO byte a byte en el fichero. No era un bug observable porque
  // `paymentRecoveryAttemptedRef` se pone a true en el primero y el segundo sale antes de tiempo,
  // pero es justo el tipo de copia que se convierte en doble cobro en cuanto alguien toca la
  // guarda. Si vuelve a aparecer dos veces, es un error.
  useEffect(() => { if (isConnected && chainId !== SVP_CHAIN_ID && (mode === 'game' || mode === 'submitting')) { setSessionId(''); setMode('error'); setErrorState({ title: 'Wrong network', message: 'Connect your wallet to SVP Chain testnet (2517).', action: 'Switch network' }) } }, [isConnected, chainId, mode])
  useEffect(() => {
    if (mode !== 'game') return
    const timer = window.setInterval(() => setSeconds((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [mode])
  useEffect(() => { if (mode === 'game' && seconds === 0) void finishGame() }, [seconds, mode])
  // FINDING (accessibility, remediated): the round could only be played with a pointer. A reaction
  // test does not need aiming, so Space/Enter anywhere on the page registers a hit. The target is
  // also auto-focused so it is reachable by keyboard immediately.
  useEffect(() => {
    if (mode !== 'game') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || (event.code !== 'Space' && event.code !== 'Enter')) return
      // El boton del escudo se activa con Space/Enter como cualquier boton. Sin esta excepcion, Space
      // sobre el escudo focused haria LAS DOS COSAS a la vez: activar el escudo y registrar un
      // acierto, porque el listener esta en `window` y ve el evento antes de que el boton lo
      // consuma. El jugador pierde medio segundo de ronda y no sabe por que.
      if ((event.target as HTMLElement | null)?.closest('[data-game-control]')) return
      event.preventDefault()
      hitTarget()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mode, target, gameSeed, startedAt])

  async function requestPlay(payment?: Hex, paymentArena?: ArenaType) {
    // El modo que se pide al servidor. En una RECUPERACION manda `paymentArena` — el modo con el
    // que se pago, leido de sessionStorage — y no el de la URL: el jugador recargó, puede haber
    // llegado por un enlace distinto, y lo que purchased es lo que hay que entregar. Sin sesion
    // previa manda la URL, y sin URL, `human`.
    const wantArena = paymentArena ?? sessionArena ?? requestedArena ?? 'human'
    if (payment) { setTxHash(payment); setMode('payment'); writeStoredPayment(payment, wantArena) }
    const response = await fetch(`/api/play?arena=${encodeURIComponent(wantArena)}`, { headers: payment ? { 'X-PAYMENT': payment } : undefined })
    if (response.status === 402) { setMode('payment'); return }
    const data = await response.json().catch(() => null)
    if (!response.ok) { setErrorState(parsePlayError(data)); setMode('error'); return }
    if (!data || typeof data !== 'object') { setErrorState({ title: 'Temporary error', message: 'The game response is invalid.', action: 'Retry' }); setMode('error'); return }
    // Congela el modo con el que el servidor ABRIO la sesion, no con el que se pidio. Si los dos
    // difieren se usa el de la sesion y se avisa: el servidor manda, porque es quien firma el score.
    const granted = typeof data.arena === 'string' ? parseArenaParam(data.arena) : undefined
    const sessionConfig = granted ? arenaByType(granted) : undefined
    if (!sessionConfig) { setErrorState({ title: 'Temporary error', message: 'The server returned an unknown arena.', action: 'Retry' }); setMode('error'); return }
    setSessionArena(sessionConfig.type)
    const sessionExpiresAt = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : Date.now() + Number(data.expiresIn ?? 60) * 1000
    // La partida dura lo que diga el registro de la arena, no 30s fijos. El plazo contra el que se
    // mide que la sesion da para una ronda completa sale de ahi tambien: si la sesion no llega
    // para `maxDurationMs` se pide otra en vez de cobrar una entrada que no se puede jugar.
    const roundMs = sessionConfig.gameplay.maxDurationMs
    const gameDeadline = Date.now() + roundMs
    if (!Number.isFinite(sessionExpiresAt) || sessionExpiresAt < gameDeadline) { setErrorState({ title: 'Session expired', message: 'The session no longer has enough time to complete the game.', action: 'Request a new game' }); setMode('error'); return }
    // Sin seed no hay ronda, y se comprueba ANTES de tocar ningun estado. Antes `moveTarget` caia a
    // la diana fija del centro y todos los clics puntuaban como aciertos, de modo que una respuesta
    // malformada del servidor era un regal de 24000 puntos. Ahora `expectedScore` necesita el seed
    // para distinguir acierto de fallo, asi que sin el no hay score que calcular: ni se limpia el
    // pago, ni se registra el sessionId, ni se entra en modo juego. El jugador recibe un error con
    // reintento y la sesion creada en el servidor se queda sin usar hasta que caduca a los 60s.
    const seed = isHexSeed(data.gameSeed) ? data.gameSeed : null
    if (!seed) { setErrorState({ title: 'Game unavailable', message: 'The game did not return a valid seed, so no round was started.', action: 'Retry' }); setMode('error'); return }
    clearStoredPayment(); setPaymentSubmitted(false); setSessionId(String(data.sessionId)); setSeconds(Math.round(roundMs / 1000)); setScore(0); eventsCountRef.current = 0; lastHitAtRef.current = -Infinity; setEvents([]); setShieldActivations([]); setOutcome(null); setStartedAt(Date.now()); setGameSeed(seed); setMode('game'); moveTarget(seed, 0, sessionConfig)
  }
  // FINDING (critical, remediated): targets used to come from Math.random(), so the server had no
  // way to check a hit against anything and the declared event stream was worth MAX_SCORE. The
  // server already issued a `gameSeed` but never used it; the target sequence is now derived from
  // that seed on both sides (lib/score-validation.ts expectedTarget), which is what the server
  // replays in app/api/play/finish.
  function moveTarget(seed: Hex | null, index: number, config: ArenaConfig) { setTarget(seed ? expectedTarget(seed, index, config.gameplay.targetRange) : { x: 50, y: 50 }) }
function elapsedMs() { return Math.min(ARENA.gameplay.maxDurationMs, Math.max(0, Date.now() - startedAt)) }
  // Solo para PINTAR el estado del escudo. El score no lo decide esto: lo decide el `atMs` exacto de
  // cada clic, via `expectedScore`. La diferencia se nota al final de la duracion del escudo, donde
  // la pantalla puede seguir encendida hasta un segundo despues de que el escudo haya dejado de
  // puntuar. Que el numero mostrado venga del dato y no de este estado es lo que evita que un
  // retraso de un segundo llegue al score firmado.
  const shieldOn = ARENA.gameplay.shield !== null && shieldActiveAt(shieldActivations, ARENA.gameplay.shield, elapsedMs())
  const shieldSpent = ARENA.gameplay.shield !== null && shieldActivations.length >= ARENA.gameplay.shield.maxActivations
  const shieldTooLate = ARENA.gameplay.shield !== null && elapsedMs() > ARENA.gameplay.shield.cannotActivateAfterMs

  function activateShield() {
    const shield = ARENA.gameplay.shield
    if (mode !== 'game' || !gameSeed || !shield || shieldSpent || shieldTooLate) return
    // El instante se redondea al entero porque es lo que el servidor valida y lo que entra en el
    // score. Un `atMs` fraccionario haria que `expectedScore` usara un valor que
    // `shieldValidationError` rechazaria, y el jugador veria su 422 'shield_shape' sin causa.
    const next = [...shieldActivations, Math.round(elapsedMs())]
    setShieldActivations(next)
    setScore(expectedScore({ score: 0, startedAt, finishedAt: 0, events, shieldActivations: next }, gameSeed, ARENA))
  }

  /**
   * Registra un CLIC, no un acierto.
   *
   * Antes esta funcion no recibia la posicion del jugador: escribia la de la diana
   * (`{ x: target.x, y: target.y }`), o sea que un fallo era imposible por construccion y todos los
   * eventos puntuaban como aciertos. Por eso no hay penalizacion que el escudo pueda bloquear: no
   * existia el fallo. Ahora el clic guarda donde se hizo y es `classifyClicks`, en el servidor, quien
   * decide si acierta. El cliente no declara el resultado, y por eso no puede declararse un acierto
   * donde fallo.
   */
  function recordClick(x: number, y: number) {
    // FINDING (medium, remediated): hitTarget had no mode guard, so a click landing in the same
    // tick that the round ended still appended an event to an already-submitted stream.
    if (mode !== 'game' || !gameSeed || eventsCountRef.current >= ARENA.gameplay.maxEvents) return
    const atMs = elapsedMs()
    // Apply the same floor the server enforces, so the displayed score always matches the
    // recomputed one instead of the whole submission being rejected as implausible.
    if (atMs - lastHitAtRef.current < ARENA.gameplay.minEventIntervalMs) return
    lastHitAtRef.current = atMs
    const index = eventsCountRef.current
    eventsCountRef.current += 1
    const next = [...events, { atMs, x, y }]
    // El acierto o el fallo se pinta con `classifyClicks`, la MISMA funcion que usa el servidor para
    // decidir los puntos. Si la UI recalculara la zona por su cuenta con `Math.abs(x - target.x)` y
    // el registro cambiara `targetTolerance` un dia, la diana se pondria roja en un clic que el
    // servidor puntua y el jugador veria un fallo donde hubo acierto. Una sola definicion.
    setOutcome(classifyClicks(next, gameSeed, ARENA.gameplay)[index] ? 'hit' : 'miss')
    // El score se recalcula con `expectedScore`, la MISMA funcion que el servidor usa para
    // recomputarlo en app/api/play/finish. Antes esta linea repetia la formula a mano
    // (`100 + max(0, 30 - floor(atMs/1000)) * 10`) y las dos copias solo coincidian de palabra:
    // cambiar el bonus en el registro hacia que el cliente Firmara un score que el servidor
    // rechazaba con 422 en cada partida. Recalcularlo sobre el array entero cuesta 60 sumas.
    setEvents(next); setScore(expectedScore({ score: 0, startedAt, finishedAt: 0, events: next, shieldActivations }, gameSeed, ARENA)); moveTarget(gameSeed, index + 1, ARENA)
  }

  /**
   * Ruta de teclado: Space/Enter cuenta como acierto sobre la diana actual.
   *
   * Es deliberado y es lo que mantiene jugable el modo a quien no usa puntero. Un fallo es "clicar
   * en otro sitio", y con teclado no hay "otro sitio": o respondes o no respondes. Penalizar al
   * teclado por no tener puntero seria una barrera de acceso, no una mecanica.
   *
   * No abre un agujero: un tramposo que quisiese max score ya puede declarar un flujo de 60 clics
   * perfectos, porque el flujo lo declara el cliente. Ver la nota de anti-cheat en AGENTS.md.
   */
  function hitTarget() { recordClick(target.x, target.y) }

  /** Traduce el clic a coordenadas 0..100 del area de juego y lo registra. */
  function onPlayfieldPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // Solo el boton principal: el derecho y el central del raton abren el menu contextual y no son
    // un intento de acertar. `event.button` es 0 en el primario tanto en raton como en tactil.
    if (event.button !== 0) return
    const box = playfieldRef.current?.getBoundingClientRect()
    if (!box || box.width <= 0 || box.height <= 0) return
    // Se recorta a 0..100 porque es lo que `event_shape` acepta. Un clic en el borde del area da
    // justo 0 o 100, y un valor de -0.3 por error de redondeo seria un 422 'event_shape' sobre una
    // partida totalmente legitima.
    const x = Math.min(100, Math.max(0, Math.round(((event.clientX - box.left) / box.width) * 100)))
    const y = Math.min(100, Math.max(0, Math.round(((event.clientY - box.top) / box.height) * 100)))
    recordClick(x, y)
  }
  async function finishGame() {
    if (!sessionId || mode !== 'game' || !address || chainId !== SVP_CHAIN_ID) return
    const submittedSession = sessionId
    setMode('submitting')
    const response = await fetch('/api/play/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: submittedSession, wallet: address, result: { score, startedAt, finishedAt: Date.now(), events, shieldActivations } }) })
    if (submittedSession !== sessionId || !address || chainId !== SVP_CHAIN_ID) { setMode('idle'); return }
    const data = await response.json().catch(() => null)
    if (!response.ok) { setErrorState(parsePlayError(data)); setMode('error'); return }
    if (data?.status === 'confirmed' && data.txHash) { setTxHash(String(data.txHash)); setMode('result'); return }
    setErrorState({ title: 'Score pending', message: 'The game server is still confirming your score.', action: 'Retry confirmation' }); setMode('error')
  }
  async function confirmScore() {
    if (!sessionId || !txHash || !address) return
    setMode('submitting')
    const response = await fetch('/api/play/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, wallet: address, txHash }) })
    const data = await response.json().catch(() => null)
    if (!response.ok) { setErrorState(parsePlayError(data)); setMode('error'); return }
    setMode('result')
  }
  async function pay() { if (!arcadeVaultV6Address || !isConnected || !address || !entryOpen || signing || confirming || !arena || isPaymentStateBlocking(paymentState)) { if (isPaymentStateBlocking(paymentState)) console.info(JSON.stringify({ event: 'duplicate_payment_blocked', paymentState })); return } try { const switchedChain = chainId === SVP_CHAIN_ID ? chainId : await switchChainAsync({ chainId: SVP_CHAIN_ID }); if (switchedChain !== SVP_CHAIN_ID) { setErrorState({ title: 'Wrong network', message: 'Connect your wallet to SVP Chain testnet (2517).', action: 'Switch network' }); setMode('error'); return } writeContract({ address: arcadeVaultV6Address, abi: arcadeVaultV6Abi, functionName: 'payToPlay', args: [ARENA.id], value: arena.entryFee }); setPaymentSubmitted(true); setMode('payment') } catch (error) { console.warn('[arcade] payment transaction failed', error); setPaymentSubmitted(false); setErrorState({ title: 'Could not start payment', message: getWeb3ErrorMessage(error), action: 'Retry' }); setMode('error') } }

  return <><a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-[#F5B935] focus:px-4 focus:py-2 focus:text-[#0B0E14]">Skip to main content</a><main id="main-content" className="min-h-screen bg-[#0B0E14] px-6 py-8 text-[#ECEEF2] lg:px-10"><div className="mx-auto max-w-5xl"><div aria-live="polite" className="sr-only">{mode === 'game' ? `Score ${score}. ${seconds} seconds remaining.${outcome ? ` Last click ${outcome === 'hit' ? 'hit' : 'missed'}.` : ''}${ARENA.gameplay.shield ? ` Shield ${shieldOn ? 'active' : shieldSpent ? 'already used' : shieldTooLate ? 'no longer available' : 'available'}.` : ''}` : mode === 'result' ? 'Score submitted.' : ''}</div>{arenaInvalid && <div role="alert" className="mb-6 border border-[#F05D5E] bg-[#241418] p-4"><p className="font-space-grotesk text-xl font-semibold text-[#F7A6A7]">Unknown mode</p><p className="mt-2 font-jetbrains-mono text-xs text-[#F7A6A7]">There is no playable arena called "{requested}". Choose one of the modes above.</p></div>}
        {mode === 'error' && <div role="alert" className="mb-6 border border-[#F05D5E] bg-[#241418] p-4"><p className="font-space-grotesk text-xl font-semibold text-[#F7A6A7]">{errorState.title}</p><p className="mt-2 font-jetbrains-mono text-xs text-[#F7A6A7]">{errorState.message}</p><button type="button" onClick={() => void (sessionId && txHash ? confirmScore() : pay())} className="mt-3 border border-[#F7A6A7] px-3 py-2 font-jetbrains-mono text-[10px] uppercase tracking-wider text-[#F7A6A7] hover:bg-[#F7A6A7] hover:text-[#241418]">{errorState.action}</button></div>}<Link href="/" className="inline-flex items-center gap-2 font-jetbrains-mono text-xs text-[#8890A0] hover:text-[#F5B935]"><ArrowLeft className="size-4" /> leave the arcade</Link><div className="mt-12 grid gap-10 lg:grid-cols-[0.72fr_1.28fr]"><section><p className="font-jetbrains-mono text-xs text-[#F5B935]">CABINET 001 / REACTION TEST</p><h1 className="mt-4 font-space-grotesk text-5xl font-semibold tracking-tight">{mode === 'error' ? errorState.title : 'Catch the signal.'}</h1><p className="mt-5 leading-relaxed text-[#8890A0]">{mode === 'error' ? errorState.message : 'Click the cyan target before the round ends.'}{mode === 'game' ? <span className="mt-1 block font-jetbrains-mono text-[10px] uppercase tracking-wider text-[#8890A0]">Keyboard: press space or enter</span> : null}</p><div className="mt-8">{!isConnected ? <button type="button" onClick={() => connect({ connector: connectors[0] })} className="inline-flex items-center gap-2 border border-[#35D0C0] px-5 py-3 font-space-grotesk font-semibold text-[#35D0C0]"><WalletCards className="size-5" /> Connect wallet</button> : <span className="font-jetbrains-mono text-xs text-[#35D0C0]">● {address?.slice(0, 6)}…{address?.slice(-4)}</span>}</div><ArenaTabs basePath="/play" locked={mode === 'game' || mode === 'submitting'} />
        <div className="mt-10 border-l-2 border-[#F5B935] bg-[#141922] p-5 font-jetbrains-mono text-xs leading-7"><span className="text-[#F5B935]">ENTRY FEE</span><br /><span className="text-2xl text-[#ECEEF2]">{arena ? `${formatUnits(arena.entryFee, 18)} SVP` : '—'}</span><div className="mt-2 flex flex-wrap gap-2 text-[10px] text-[#8890A0]"><span className="border border-[#2a2e3a] px-2 py-1">x402</span><span className="border border-[#2a2e3a] px-2 py-1">payToPlay()</span><span className="border border-[#2a2e3a] px-2 py-1">SVP testnet</span></div></div></section><section className="border-2 border-[#2a2e3a] bg-[#141922] p-3"><div ref={playfieldRef} onPointerDown={onPlayfieldPointerDown} className="relative min-h-[450px] cursor-crosshair touch-none overflow-hidden bg-[#090b10] select-none" role="application" aria-label="Reaction test game"><div className="absolute left-5 top-5 flex gap-6 font-jetbrains-mono text-xs text-[#8890A0]"><span>SCORE <b className="text-[#F5B935]">{score.toString().padStart(5, '0')}</b></span>{mode === 'game' && <span>TIME <b className="text-[#35D0C0]">00:{seconds.toString().padStart(2, '0')}</b></span>}</div>{ARENA.gameplay.shield && mode === 'game' && <button type="button" data-game-control="" onClick={activateShield} disabled={shieldSpent || shieldTooLate} aria-label={shieldOn ? 'Shield active' : shieldSpent ? 'Shield already used' : shieldTooLate ? 'Shield can no longer be activated' : 'Activate shield'} className={`absolute right-5 top-5 border px-3 py-1 font-jetbrains-mono text-[10px] uppercase tracking-wider transition-colors ${shieldOn ? 'border-[#F5B935] bg-[#F5B935] text-[#0B0E14]' : shieldSpent || shieldTooLate ? 'border-[#2a2e3a] text-[#5a6270]' : 'border-[#F5B935] text-[#F5B935] hover:bg-[#F5B935] hover:text-[#0B0E14]'}`}>{shieldOn ? 'Shield on' : shieldSpent ? 'Shield used' : shieldTooLate ? 'Shield lost' : 'Shield'}</button>}{/* La diana se dimensiona a `targetTolerance * 2` por ciento en AMBOS ejes, y eso es
            deliberado: la zona que puntua es elipse, porque `x` es porcentaje del ancho del area e
            `y` del alto. Con un area de 700x450, la tolerancia 6 son 42px a lo ancho y 27px a lo
            alto. Un `size-12` fijo dibujaba un circulo de 48px que era mayor que la zona real, y en
            `hard` —donde la tolerancia era 2— clicar dentro de lo que se veia no puntuaba nada sin
            forma de saberlo. Medir el area en pixeles para compensar habria creado una segunda
            definicion de la zona que el servidor no comparte, y por eso el porcentaje es el que se
            dibuja tal cual. El color comunica el resultado del ultimo clic; la forma comunica donde
            puntua. Las dos cosas se derivan de la MISMA constante del registro. */}
        {mode === 'game' && <button type="button" tabIndex={-1} aria-hidden="true" style={{ left: `${target.x}%`, top: `${target.y}%`, width: `${ARENA.gameplay.targetTolerance * 2}%`, height: `${ARENA.gameplay.targetTolerance * 2}%`, borderColor: outcome === 'miss' ? '#F05D5E' : '#35D0C0', backgroundColor: outcome === 'miss' ? '#F05D5E20' : '#35D0C020', boxShadow: `0 0 36px ${outcome === 'miss' ? '#F05D5E' : '#35D0C0'}` }} className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-4 transition-colors duration-100" />}{(mode === 'idle' || mode === 'payment' || mode === 'error') && <div className="flex min-h-[450px] items-center justify-center p-8 text-center"><div><p className="font-jetbrains-mono text-xs text-[#8890A0]">{mode === 'error' ? 'SESSION_ERROR' : 'READY_STATE'}</p><h2 className="mt-4 font-space-grotesk text-3xl">{mode === 'error' ? 'Sesión inválida o expirada' : 'Insert coin to begin'}</h2><button type="button" onClick={mode === 'payment' ? pay : () => requestPlay()} disabled={!isConnected || signing || confirming} className="mt-7 inline-flex items-center gap-2 bg-[#F5B935] px-6 py-3 font-space-grotesk font-semibold text-[#0B0E14] disabled:opacity-50">{signing || confirming ? <Loader2 className="size-4 animate-spin" /> : null}{mode === 'payment' ? 'PAY AND PLAY' : 'Request game'}</button></div></div>}{mode === 'submitting' && <div className="flex min-h-[450px] items-center justify-center"><p className="flex items-center gap-3 font-jetbrains-mono text-sm text-[#35D0C0]"><Loader2 className="animate-spin" /> RECORDING SCORE ON-CHAIN…</p></div>}{mode === 'result' && <div className="flex min-h-[450px] items-center justify-center p-8 text-center"><div><p className="font-jetbrains-mono text-xs text-[#F5B935]">ROUND COMPLETE</p><h2 className="mt-4 font-space-grotesk text-6xl">{score}</h2><p className="mt-3 text-[#8890A0]">Your score was recorded for this epoch.</p><a className="mt-6 inline-block font-jetbrains-mono text-xs text-[#35D0C0] underline" href={`https://explorer.svpchain.com/tx/${txHash}`} target="_blank" rel="noreferrer">VIEW TRANSACTION IN EXPLORER</a><button type="button" onClick={() => { setMode('idle'); setSessionId('') }} className="mt-8 block w-full border border-[#2a2e3a] px-5 py-3 font-space-grotesk">PAY AGAIN</button></div></div>}</div></section></div></div></main>
</>
}
// `PlayRoom` lee `useSearchParams`, y en App Router eso obliga a un limite de Suspense: sin el,
// Next no puede prerenderizar la ruta y falla el build. El fallback va vacio a proposito, la
// pagina ya muestra un estado de carga por su cuenta y no quiero un esqueleto parpadeando encima.
export default function Play() { return <WalletProvider><Suspense fallback={null}><PlayRoom /></Suspense></WalletProvider> }
