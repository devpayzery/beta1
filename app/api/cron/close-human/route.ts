import { NextResponse } from 'next/server'
import { ARENAS, isPlayable } from '@/lib/arcade-arenas'
import { ContractMismatchError, closeEpochIfDue, readArena, readEpochClosed, waitForConfirmation } from '@/lib/server-blockchain'
import { authorizeCronRequest, getCronAuthResponse } from '@/lib/cron-auth'
import { consumeLimit, rateLimitResponse, requestIp } from '@/lib/rate-limit'

export const runtime = 'nodejs'

// AVISO SOBRE EL NOMBRE DE ESTA RUTA
//
// Se llama `close-human` porque asi estaba cuando solo existia la arena human, y no se renombra
// porque este path lo referencia un cron configurado FUERA del repo (no hay vercel.json, asi que
// no se puede ver ni actualizar desde aqui). Renombrarla dejaria el cron llamando a una ruta
// inexistente y ninguna epoch cerraria, en silencio.
//
// Lo que hace ya no es "cerrar human": recorre TODAS las arenas jugables del registro. Si el
// cron se puede mover, el nombre que corresponde es `close-epoch`. Mientras tanto, la
// respuesta incluye el detalle por arena para que el operador vea que se cierran tres.
export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  const auth = authorizeCronRequest(request, process.env.CRON_SECRET)
  if (!auth.ok) return getCronAuthResponse(auth, requestId)
  try {
    const limit = await consumeLimit('cron_ip', requestIp(request))
    if (!limit.allowed) return rateLimitResponse(requestId, limit.retryAfter)
  } catch {
    return NextResponse.json({ error: 'RATE_LIMIT_UNAVAILABLE', requestId }, { status: 503 })
  }

  // La lista de arenas sale del registro, no de una constante en la ruta. Anadir un modo al
  // contrato lo tiene que hacer cerrar el cron sin tocar este archivo; si la lista estuviera
  // aqui, un cuarto modo no cerraria nunca y nada en los logs lo dira, porque el cron seguira
  // respondiendo 200 por los otros tres.
  const targets = ARENAS.filter((arena) => arena.playable && isPlayable(arena.type))
  const startedAt = Date.now()
  const results: Record<string, unknown>[] = []

  for (const target of targets) {
    try {
      const result = await closeEpochIfDue(target.id, requestId)
      if (result.status === 'not_due' || result.status === 'already_closed') {
        console.info(JSON.stringify({ event: result.status === 'not_due' ? 'epoch_close_not_due' : 'epoch_close_already_closed', requestId, arena: target.type, epoch: result.epoch.toString(), durationMs: Date.now() - startedAt }))
        results.push({ arena: target.type, status: result.status, epoch: result.epoch.toString() })
        continue
      }
      console.info(JSON.stringify({ event: 'epoch_close_submitted', requestId, arena: target.type, epoch: result.epoch.toString(), txHash: result.txHash, durationMs: Date.now() - startedAt }))
      if (!result.txHash) throw new Error('EPOCH_CLOSE_HASH_MISSING')
      const receipt = await waitForConfirmation(result.txHash, requestId)
      if (receipt.status !== 'success') throw new Error('EPOCH_CLOSE_REVERTED')
      // Reconciliacion: se comprueba en la cadena que la epoch quedo cerrada Y que la arena avanzo.
      // Solo mirar `closed` no basta: una arena podria quedar marcada cerrada sin avanzar de epoch
      // si el cierre se escribio con la epoch equivocada, y entonces volveria a cerrar la misma una
      // y otra vez sin quejarse.
      const [arena, epochClosed] = await Promise.all([readArena(target.id, requestId), readEpochClosed(result.epoch, target.id, requestId)])
      if (!epochClosed || arena.currentEpoch <= result.epoch) throw new Error('EPOCH_CLOSE_RECONCILIATION_FAILED')
      console.info(JSON.stringify({ event: 'epoch_close_confirmed', requestId, arena: target.type, epoch: result.epoch.toString(), txHash: result.txHash, nextEpoch: arena.currentEpoch.toString(), durationMs: Date.now() - startedAt }))
      results.push({ arena: target.type, status: 'confirmed', epoch: result.epoch.toString(), txHash: result.txHash, nextEpoch: arena.currentEpoch.toString() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(JSON.stringify({ event: 'epoch_close_failed', requestId, arena: target.type, error: message, durationMs: Date.now() - startedAt }))
      results.push({ arena: target.type, status: 'failed', error: error instanceof ContractMismatchError ? 'CONTRACT_MISMATCH' : 'BLOCKCHAIN_WRITE_FAILED' })
    }
  }

  // Un fallo en una arena no puede tapar el resultado de las otras: se responde 200 con el
  // detalle por arena y se devuelve el codigo en el cuerpo. Devolver 500 entero haria que el
  // cronomatico lo reintentara y una arena sana se cerraria dos veces.
  const failed = results.filter((entry) => entry.status === 'failed')
  return NextResponse.json({ arenas: results, failed: failed.length, requestId }, { status: 200 })
}