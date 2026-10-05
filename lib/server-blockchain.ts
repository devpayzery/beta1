import 'server-only'

import { createWalletClient, http, keccak256, parseEther, parseEventLogs, toFunctionSelector, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcadeVaultV6Abi, V6_SCORE_TYPES } from '@/lib/arcade-vault-v6-abi'
import { arenaById, isPlayable, type ArenaId, type VynarPoints } from '@/lib/arcade-arenas'
import { vynarAbi, VYNAR_ADDRESS } from '@/lib/vynar-config'
import { derivePaymentEpoch } from '@/lib/payment-epoch'
import { getServerEnv } from '@/lib/server-env'
import { rpcChainConfig, reportWriteResult, selectWriteRpc, withRpcRead } from '@/lib/rpc-manager'

export function chainConfig() { return rpcChainConfig() }
export function paymentAmountWei() { return parseEther(getServerEnv().paymentAmount) }

/**
 * Estado de una arena leido de la cadena, con los outputs YA NOMBRADOS.
 *
 *FINDING (critical, corregido): antes se leia `arenas(arena)` y se usaba por indice
 * (`arena[7]` para `active`). En V6 ese getter pasa de 9 a 11 outputs y `active` salta del
 * indice 7 al 9, porque en medio se insertaron `totalPaid` y `maxEntries`. Leer `arena[7]`
 * esperando un bool devuelve un bigint: no lanza, no falla el typecheck, y produce un
 * `!arena[7]` que siempre da false porque un bigint es truthy. El resultado es que una arena
 * apagada se lee como activa y `closeEpoch` se intenta sobre una arena que no acepta pagos.
 *
 * `getArenaInfo` tiene 10 outputs y devuelve `secondsLeft` ya calculada. Se usa ese getter y se
 * desestructura POR POSICION en una sola linea, que es el unico sitio del repo donde aparece esa
 * forma de leer un retorno multi-output de viem.
 *
 * POR QUE POSICIONAL Y NO LOS NOMBRES DEL ABI
 *
 * Leer `resultado.nombre` de un retorno de viem parece gratis y no lo es. `viem` delega en
 * `abitype`, cuya `unwrapName` resuelve el nombre de cada salida contra
 * `AbiParameterTupleNameLookup`: una lista generada de ~1500 nombres arrastrados de ABIs reales.
 * Si el nombre esta en la lista, la tupla conserva la etiqueta; si no, cae al index signature
 * `Record<string, [type]>` y devuelve `[type]` SIN NOMBRE.
 *
 * Comprobado en este repo: `pool`, `active`, `paused` y `bps` si estan en la lista y sobreviven;
 * `currentEpoch`, `epochEnd`, `entryFee`, `secondsLeft`, `winners`, `winnerCount`, `closed` y
 * `prizePool` NO estan y se degradan a posicional. Que un campo conserve su nombre depende de si
 * otro proyecto uso alguna vez ese identificador en un contrato.
 *
 * La consecuencia practica es que `currentResult.closed` puede compilar en un sitio y no en otro
 * segun como se escribio el ABI, y un `as` lo silencia en los dos. Por eso la desestructura
 * posicional con nombres locales es la unica forma honesta: no depende de una lista de terceros,
 * y el cambio de forma del retorno se ve como un error de typecheck en vez de como un dato
 * leido de la posicion equivocada.
 */
export type OnChainArena = {
  id: ArenaId
  entryFee: bigint
  protocolFeeBps: bigint
  epochDuration: bigint
  currentEpoch: bigint
  epochStart: bigint
  epochEnd: bigint
  pool: bigint
  active: boolean
  paused: boolean
  secondsLeft: bigint
}

export async function readArena(arenaId: ArenaId, requestId = crypto.randomUUID()): Promise<OnChainArena> {
  const raw = await withRpcRead(`getArenaInfo(${arenaId})`, requestId, (client) => client.readContract({ address: getServerEnv().vault, abi: arcadeVaultV6Abi, functionName: 'getArenaInfo', args: [arenaId] }))
  const [entryFee, protocolFeeBps, epochDuration, currentEpoch, epochStart, epochEnd, pool, active, paused, secondsLeft] = raw
  return { id: arenaId, entryFee, protocolFeeBps, epochDuration, currentEpoch, epochStart, epochEnd, pool, active, paused, secondsLeft }
}

export async function currentEpoch(arena: ArenaId, requestId = crypto.randomUUID()) {
  return (await readArena(arena, requestId)).currentEpoch
}

export async function entryFee(arena: ArenaId, requestId = crypto.randomUUID()) {
  return (await readArena(arena, requestId)).entryFee
}

export async function epochDuration(arena: ArenaId, requestId = crypto.randomUUID()) {
  return (await readArena(arena, requestId)).epochDuration
}

export class ContractMismatchError extends Error {
  code = 'CONTRACT_MISMATCH' as const
}

/**
 * Comprueba que el despliegue configurado es un ArcadeVaultV6 con el que esta app puede
 * trabajar ANTES de tocar la cadena. Falla ruidosamente: un despliegue equivocado no puede
 * manifestarse en mitad de un cierre de epoch.
 */
export async function verifyVaultCompatibility(arenaId: ArenaId, requestId = crypto.randomUUID()) {
  try {
    const [state, configuredSigner] = await Promise.all([readArena(arenaId, requestId), withRpcRead('gameServerSigner', requestId, (client) => client.readContract({ address: getServerEnv().vault, abi: arcadeVaultV6Abi, functionName: 'gameServerSigner' }))])
    const account = privateKeyToAccount(getServerEnv().privateKey)
    if (account.address.toLowerCase() !== configuredSigner.toLowerCase()) throw new ContractMismatchError('GAME_SERVER_PRIVATE_KEY does not match the contract gameServerSigner')
    // El fee se compara contra el registro, no contra una constante: si alguien cambia el
    // precio de una arena hay que cambiarlo en un sitio, y el despliegue se valida solo.
    const expected = arenaById(arenaId)
    if (!expected) throw new ContractMismatchError(`Unknown arena id ${arenaId}`)
    const mismatches: string[] = []
    if (state.currentEpoch < BigInt(1)) mismatches.push(`currentEpoch=${state.currentEpoch.toString()} (must be >= 1)`)
    if (state.entryFee !== expected.entryFeeWei) mismatches.push(`entryFee=${state.entryFee.toString()} (expected ${expected.entryFeeWei.toString()})`)
    if (state.protocolFeeBps !== BigInt(expected.protocolFeeBps)) mismatches.push(`protocolFeeBps=${state.protocolFeeBps.toString()} (expected ${expected.protocolFeeBps})`)
    if (state.epochDuration !== BigInt(expected.epochDurationSeconds)) mismatches.push(`epochDuration=${state.epochDuration.toString()} (expected ${expected.epochDurationSeconds})`)
    if (!state.active) mismatches.push('active=false')
    if (state.paused) mismatches.push('paused=true')
    if (mismatches.length > 0) throw new ContractMismatchError(`ArcadeVaultV6 ${expected.type} arena is not compatible: ${mismatches.join(', ')}`)
    return { ...state, signer: configuredSigner }
  } catch (error) {
    if (error instanceof ContractMismatchError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (/unknown function|function selector|does not exist|execution reverted|revert/i.test(message)) throw new ContractMismatchError('Configured deployment does not expose the ArcadeVaultV6 read surface')
    throw error
  }
}

export async function verifyPayment(hash: Hex, arenaId: ArenaId, requestId = crypto.randomUUID()) {
  const env = getServerEnv()
  const [tx, receipt, state] = await Promise.all([
    withRpcRead('eth_getTransaction', requestId, (client) => client.getTransaction({ hash })),
    withRpcRead('eth_getTransactionReceipt', requestId, (client) => client.getTransactionReceipt({ hash })),
    readArena(arenaId, requestId),
  ])
  const selector = toFunctionSelector('payToPlay(uint8)')
  // El importe se compara contra el fee ON-CHAIN y contra el del registro: si divergen, el
  // despliegue no es el que esta app cree, y aceptar el pago dejaria al jugador pagando un
  // precio que el contrato no aplica.
  const expectedFee = arenaById(arenaId)?.entryFeeWei
  const valid = receipt.status === 'success' && tx.chainId === env.chainId && tx.to?.toLowerCase() === env.vault.toLowerCase() && tx.value === state.entryFee && expectedFee !== undefined && tx.value === expectedFee && tx.input.slice(0, 10).toLowerCase() === selector.toLowerCase() && tx.input.slice(10).toLowerCase() === arenaId.toString(16).padStart(64, '0')
  if (!valid) throw new Error('INVALID_PAYMENT')
  const block = await withRpcRead('payment.block', requestId, (client) => client.getBlock({ blockNumber: receipt.blockNumber }))
  const epoch = derivePaymentEpoch({ currentEpoch: state.currentEpoch, currentEpochStart: state.epochStart, epochDuration: state.epochDuration, paymentTimestamp: block.timestamp })
  if (epoch < BigInt(1)) throw new Error('INVALID_PAYMENT_EPOCH')
  return { txHash: hash, wallet: tx.from, amountWei: tx.value, chainId: tx.chainId, epoch, arena: arenaId }
}

export async function prepareScoreAuthorization(player: Address, score: number, sessionId: Hex, epoch: bigint, arenaId: ArenaId) {
  const env = getServerEnv()
  const account = privateKeyToAccount(env.privateKey)
  const nonce = BigInt(keccak256(sessionId))
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 120)
  const domain = await withRpcRead('eip712Domain', crypto.randomUUID(), async (client) => {
    const [, name, version, chainId, verifyingContract] = await client.readContract({ address: env.vault, abi: arcadeVaultV6Abi, functionName: 'eip712Domain' })
    if (chainId !== BigInt(env.chainId) || verifyingContract.toLowerCase() !== env.vault.toLowerCase()) throw new ContractMismatchError('On-chain EIP712 domain does not match the configured chain or vault')
    return { name, version, chainId, verifyingContract }
  })
  const signature = await account.signTypedData({ domain, types: V6_SCORE_TYPES, primaryType: 'Score', message: { arena: arenaId, player, score: BigInt(score), sessionId, epoch, nonce, deadline } })
  return { arena: arenaId, player, score: BigInt(score), sessionId, epoch, nonce, deadline, signature }
}

export class MintPendingError extends Error {
  code = 'PENDING_MINT' as const
  constructor(public readonly scoreHash: Hex) { super('Score confirmed but VYNAR mint is pending') }
}

/**
 * `vynarPoints` SEPARADO de `score`, y no opcional con un default.
 *
 * Los dos numeros van en transacciones distintas: `score` a `recordScore`, que decide rankings y
 * premios, y `vynarPoints` a `mintForScoreOnce`, que decide quantos VYNAR entra. El booster vive
 * solo en el segundo. Que no haya `= score` por defecto es lo que hace visible la proxima vez que
 * alguien anada una llamada y se olvide del booster: un default aqui reproducia en silencio la
 * partida sin 2x, que es el fallo que nadie ve porque el resultado sigue siendo "correcto".
 */
export async function submitScoreFromServer(input: { player: Address; score: number; vynarPoints: VynarPoints; sessionId: Hex; epoch: bigint; arenaId: ArenaId }, requestId = crypto.randomUUID()) {
  const { player, score, vynarPoints, sessionId, epoch, arenaId } = input
  const env = getServerEnv()
  const account = privateKeyToAccount(env.privateKey)
  const selected = selectWriteRpc()
  const client = createWalletClient({ account, chain: chainConfig(), transport: http(selected.url, { timeout: env.rpcTimeoutMs }) })
  const authorization = await prepareScoreAuthorization(player, score, sessionId, epoch, arenaId)
  const started = Date.now()
  const scoreHash = await client.writeContract({ address: env.vault, abi: arcadeVaultV6Abi, functionName: 'recordScore', args: [authorization.arena, authorization.player, authorization.score, authorization.sessionId, authorization.epoch, authorization.nonce, authorization.deadline, authorization.signature], account })
  reportWriteResult(selected, true, Date.now() - started)
  const scoreReceipt = await waitForConfirmation(scoreHash, requestId)
  if (scoreReceipt.status !== 'success') throw new Error('SCORE_TX_FAILED')
  verifyScoreRecorded(scoreReceipt, { player, arena: arenaId, epoch, score, sessionId })
  const vynarAddress = VYNAR_ADDRESS
  if (!vynarAddress) throw new Error('VYNAR_ADDRESS_NOT_CONFIGURED')
  const rewarded = await withRpcRead('vynar.scoreRewarded', requestId, (readClient) => readClient.readContract({ address: vynarAddress, abi: vynarAbi, functionName: 'scoreRewarded', args: [sessionId] }))
  if (rewarded) return { scoreHash, mintHash: undefined }
  try {
    const mintHash = await client.writeContract({ address: vynarAddress, abi: vynarAbi, functionName: 'mintForScoreOnce', args: [player, BigInt(vynarPoints), sessionId], account })
    const mintReceipt = await waitForConfirmation(mintHash, requestId)
    if (mintReceipt.status !== 'success') throw new Error('VYNAR_MINT_TX_FAILED')
    return { scoreHash, mintHash }
  } catch {
    throw new MintPendingError(scoreHash)
  }
}

/**
 * Reintenta un mint a medias. `vynarPoints` llega desde la fila persistida, NUNCA se recalcula aqui.
 *
 * El motivo es que `mintForScoreOnce` es de un solo disparo por `rewardId`: si el primer intento
 * llego a la cadena y la confirmacion se perdio, la recuperacion que vuelve a mintear es un no-op y
 * la que corre es la que NO llego. Recalcular el total en la recuperacion produciria dos totales
 * distintos para la misma partida, y el que ganase seria el que se confirmo antes. Como la fila de
 * `arcade_scores` guarda el `vynar_points` que se uso, la recuperacion mintea exactamente el mismo
 * numero o no mintea nada.
 *
 * POR QUE UN OBJETO Y NO PARAMETROS SUELTOS, aqui y en `submitScoreFromServer`
 *
 * Los dos numeros son los dos mismos tipos, `number`, y van en el mismo orden en las dos llamadas.
 * Con posicion, pasar `score` donde toca `vynarPoints` —el error que hace un booster perder su 2x en
 * una recuperacion, sin error ni log— compila sin quejarse: se verifico, y el fallo es invisible
 * tanto a `tsc` como a un test que no cubre la ruta. Con el objeto, la llamada dice
 * `{ player, vynarPoints: pending.data.vynar_points }` y el nombre del campo es el que ata el valor a
 * su procedencia. Es el mismo motivo por el que `prepareScoreAuthorization` y `verifyScoreRecorded`
 * reciben objetos, y por el que `/api/play` recibe la arena como `{ arena }`.
 *
 * Y no hay un `score` en la firma de `recoverScoreMint`: la recuperacion no lo necesita, asi que
 * dejarlo invites a pasarlo.
 */
export async function recoverScoreMint(input: { player: Address; vynarPoints: VynarPoints; sessionId: Hex; scoreHash: Hex }, requestId = crypto.randomUUID()) {
  const { player, vynarPoints, sessionId, scoreHash } = input
  const vynarAddress = VYNAR_ADDRESS
  if (!vynarAddress) throw new Error('VYNAR_ADDRESS_NOT_CONFIGURED')
  const rewarded = await withRpcRead('vynar.scoreRewarded.recovery', requestId, (client) => client.readContract({ address: vynarAddress, abi: vynarAbi, functionName: 'scoreRewarded', args: [sessionId] }))
  if (rewarded) return { scoreHash, mintHash: undefined }
  const env = getServerEnv(); const account = privateKeyToAccount(env.privateKey); const selected = selectWriteRpc()
  const client = createWalletClient({ account, chain: chainConfig(), transport: http(selected.url, { timeout: env.rpcTimeoutMs }) })
  const mintHash = await client.writeContract({ address: vynarAddress, abi: vynarAbi, functionName: 'mintForScoreOnce', args: [player, BigInt(vynarPoints), sessionId], account })
  const receipt = await waitForConfirmation(mintHash, requestId)
  if (receipt.status !== 'success') throw new Error('VYNAR_MINT_TX_FAILED')
  return { scoreHash, mintHash }
}

export async function readEpochClosed(epoch: bigint, arenaId: ArenaId, requestId = crypto.randomUUID()) {
  return withRpcRead('getEpochResult.closed', requestId, async (client) => {
    const [, , , , , , closed] = await client.readContract({ address: getServerEnv().vault, abi: arcadeVaultV6Abi, functionName: 'getEpochResult', args: [arenaId, epoch] })
    return closed
  })
}

export async function closeEpochIfDue(arenaId: ArenaId, requestId = crypto.randomUUID()): Promise<{ status: 'not_due' | 'submitted' | 'already_closed'; epoch: bigint; txHash?: Hex }> {
  const env = getServerEnv()
  const state = await readArena(arenaId, requestId)
  const epoch = state.currentEpoch
  if (state.secondsLeft > BigInt(0)) return { status: 'not_due', epoch }
  const closed = await readEpochClosed(epoch, arenaId, requestId)
  if (closed) return { status: 'already_closed', epoch }
  const account = privateKeyToAccount(env.privateKey)
  const configuredSigner = await withRpcRead('gameServerSigner', requestId, (client) => client.readContract({ address: env.vault, abi: arcadeVaultV6Abi, functionName: 'gameServerSigner' }))
  if (account.address.toLowerCase() !== configuredSigner.toLowerCase()) throw new ContractMismatchError('GAME_SERVER_PRIVATE_KEY does not match gameServerSigner')
  const selected = selectWriteRpc()
  const client = createWalletClient({ account, chain: chainConfig(), transport: http(selected.url, { timeout: env.rpcTimeoutMs }) })
  const started = Date.now()
  try {
    await withRpcRead('simulate closeEpoch', requestId, (readClient) => readClient.simulateContract({ address: env.vault, abi: arcadeVaultV6Abi, functionName: 'closeEpoch', args: [arenaId], account }))
    const txHash = await client.writeContract({ address: env.vault, abi: arcadeVaultV6Abi, functionName: 'closeEpoch', args: [arenaId], account })
    reportWriteResult(selected, true, Date.now() - started)
    return { status: 'submitted', epoch, txHash }
  } catch (error) {
    reportWriteResult(selected, false, Date.now() - started)
    const reconciled = await readEpochClosed(epoch, arenaId, requestId)
    if (reconciled) return { status: 'already_closed', epoch }
    throw error
  }
}

export async function readEpochResult(epoch: bigint, arenaId: ArenaId, requestId = crypto.randomUUID()) {
  return withRpcRead('getEpochResult', requestId, async (client) => {
    const [winners, bps, winnerCount, prizePool, paidOut, totalPaid, closed, voided, swept] = await client.readContract({ address: getServerEnv().vault, abi: arcadeVaultV6Abi, functionName: 'getEpochResult', args: [arenaId, epoch] })
    return { winners, bps, winnerCount, prizePool, paidOut, totalPaid, closed, voided, swept }
  })
}

export async function readTop10(epoch: bigint, arenaId: ArenaId, requestId = crypto.randomUUID()) {
  return withRpcRead(`getTop10(${arenaId},${epoch})`, requestId, (client) => client.readContract({ address: getServerEnv().vault, abi: arcadeVaultV6Abi, functionName: 'getTop10', args: [arenaId, epoch] }))
}

export async function readLeaderboardEntry(epoch: bigint, index: bigint, arenaId: ArenaId, requestId = crypto.randomUUID()) {
  return withRpcRead(`leaderboard(${arenaId},${epoch},${index})`, requestId, (client) => client.readContract({ address: getServerEnv().vault, abi: arcadeVaultV6Abi, functionName: 'leaderboard', args: [arenaId, epoch, index] }))
}

export async function waitForConfirmation(hash: Hex, requestId = crypto.randomUUID()) {
  return withRpcRead('eth_getTransactionReceipt', requestId, (client) => client.waitForTransactionReceipt({ hash }))
}

export function verifyScoreRecorded(receipt: Awaited<ReturnType<typeof waitForConfirmation>>, expected: { player: Address; arena: number; epoch: bigint; score: number; sessionId: Hex }) {
  const parsed = receipt.logs.flatMap((log) => {
    try { return parseEventLogs({ abi: arcadeVaultV6Abi, logs: [log] }).filter((item) => item.eventName === 'ScoreRecorded') }
    catch { return [] }
  })[0]
  if (!parsed || parsed.eventName !== 'ScoreRecorded') throw new Error('SCORE_RECORDED_EVENT_MISSING')
  const args = parsed.args
  if (args.player.toLowerCase() !== expected.player.toLowerCase() || Number(args.arena) !== expected.arena || args.epoch !== expected.epoch || args.score !== BigInt(expected.score) || args.sessionId.toLowerCase() !== expected.sessionId.toLowerCase()) throw new Error('SCORE_RECORDED_MISMATCH')
  return true
}

export async function isSessionUsed(sessionId: Hex, requestId = crypto.randomUUID()) {
  return withRpcRead('usedSessionIds', requestId, (client) => client.readContract({ address: getServerEnv().vault, abi: arcadeVaultV6Abi, functionName: 'usedSessionIds', args: [sessionId] }))
}

/** Arenas que la app puede ofrecer, derivado del registro y no de una lista en la UI. */
export function playableArenas() { return [0, 1, 2].map((id) => arenaById(id as ArenaId)).filter((a): a is NonNullable<typeof a> => Boolean(a?.playable && isPlayable(a.type))) }

export function publicChainClient(): never {
  throw new Error('Use the RPC manager-backed blockchain functions instead of a direct client')
}