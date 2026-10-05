import { decodeFunctionData, type Hex } from 'viem'
import { vynarRewardsV3Abi } from '@/lib/vynar-rewards-v3-abi'
import type { ArenaId } from '@/lib/arcade-arenas'

/**
 * Valida el calldata de un `claim` de VynarRewards contra lo que la app cree que seESTA
 * reclamando.
 *
 * `arena` es OBLIGATORIO y no tiene valor por defecto. Antes aceptaba `arena?: number` y
 * resolvia a 0 cuando venia indefinido, lo que hacia que una consulta de MEDIUM sin arena
 * se validara como si fuera HUMAN. Con cuatro arenas eso no es un valor por defecto
 * comodo: es un pago validado contra la epoch equivocada.
 */
export function validateVyrClaimCalldata(data: Hex, expected: { arena: ArenaId; epoch: bigint }) {
  let decoded: ReturnType<typeof decodeFunctionData<typeof vynarRewardsV3Abi>>
  try { decoded = decodeFunctionData({ abi: vynarRewardsV3Abi, data }) } catch { return 'CLAIM_TX_FUNCTION_MISMATCH' as const }
  if (decoded.functionName !== 'claim') return 'CLAIM_TX_FUNCTION_MISMATCH' as const
  const [arena, epoch] = decoded.args
  if (arena !== expected.arena) return 'CLAIM_TX_ARENA_MISMATCH' as const
  if (epoch !== expected.epoch) return 'CLAIM_TX_EPOCH_MISMATCH' as const
  return null
}