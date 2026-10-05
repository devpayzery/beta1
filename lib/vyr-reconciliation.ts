import 'server-only'

import { getAddress, type Address, type Hex } from 'viem'
import { createAdminClient } from '@/lib/supabase/admin'
import { withRpcRead } from '@/lib/rpc-manager'
import { VYNAR_REWARDS_V3_ADDRESS } from '@/lib/vynar-config'
import { vynarRewardsV3Abi } from '@/lib/vynar-rewards-v3-abi'
import type { ArenaId } from '@/lib/arcade-arenas'
import { waitForConfirmation } from '@/lib/server-blockchain'
import { getServerEnv } from '@/lib/server-env'
import { validateVyrClaimCalldata } from '@/lib/vyr-claim-validation'

type DistributionSnapshot = {
  id: string
  epoch: string | number | bigint
  merkle_root: string
  total_allocation: string | number | bigint
  total_points: string | number | bigint
  participant_count: number
  reward_per_point: string | number | bigint
  status: string
  published: boolean
  publish_tx_hash: string | null
}

type ChainDistribution = readonly [bigint, bigint, bigint, bigint, boolean, boolean, boolean]

export type VyrPublishReconciliation = {
  status: 'published' | 'failed' | 'publishing' | 'mismatch'
  txHash: Hex | null
  reason?: string
}

function chainValues(value: ChainDistribution) {
  return { totalAllocation: value[0], positionCount: value[1], funded: value[4], settled: value[5], canceled: value[6] }
}

function matches(snapshot: DistributionSnapshot, chain: ChainDistribution) {
  const actual = chainValues(chain)
  const mismatch = [
    actual.totalAllocation !== BigInt(snapshot.total_allocation) && 'totalAllocation',
    actual.funded !== true && 'funded',
    actual.canceled === true && 'canceled',
  ].filter(Boolean) as string[]
  return mismatch
}

export async function reconcileVyrPublish(snapshot: DistributionSnapshot, arena: ArenaId, requestId = crypto.randomUUID()): Promise<VyrPublishReconciliation> {
  const txHash = snapshot.publish_tx_hash as Hex | null
  console.info(JSON.stringify({ event: 'VYR_PUBLISH_RECONCILE_START', requestId, epoch: String(snapshot.epoch), arena, txHash, dbStatus: snapshot.status }))
  const distributorAddress = VYNAR_REWARDS_V3_ADDRESS
  if (!distributorAddress) return { status: 'mismatch', txHash, reason: 'VYNAR_REWARDS_V3_NOT_CONFIGURED' }
  const db = createAdminClient()
  const readChain = () => withRpcRead('vyr.epochRewards', requestId, (client) => client.readContract({ address: distributorAddress, abi: vynarRewardsV3Abi, functionName: 'epochRewards', args: [arena, BigInt(snapshot.epoch)] }))
  const chain = await readChain()
  const actual = chainValues(chain as ChainDistribution)
  const mismatch = matches(snapshot, chain as ChainDistribution)
  if (actual.funded === true && mismatch.length === 0) {
    const updated = await db.from('vyr_epoch_distributions').update({ status: 'published', published: true, published_at: new Date().toISOString() }).eq('id', snapshot.id).select('*').single()
    if (updated.error) throw updated.error
    console.info(JSON.stringify({ event: 'VYR_PUBLISH_CHAIN_CONFIRMED', requestId, epoch: String(snapshot.epoch), txHash }))
    return { status: 'published', txHash }
  }
  let receipt: Awaited<ReturnType<typeof waitForConfirmation>> | null = null
  if (txHash) {
    try { receipt = await waitForConfirmation(txHash, requestId) } catch (error) {
      console.warn(JSON.stringify({ event: 'VYR_PUBLISH_TX_UNKNOWN', requestId, epoch: String(snapshot.epoch), txHash, error: error instanceof Error ? error.message : 'receipt unavailable' }))
    }
  }
  if (actual.funded === true) {
    console.error(JSON.stringify({ event: 'VYR_PUBLISH_CHAIN_MISMATCH', requestId, epoch: String(snapshot.epoch), txHash, fields: mismatch }))
    await db.from('vyr_epoch_distributions').update({ status: 'mismatch', published: false }).eq('id', snapshot.id)
    return { status: 'mismatch', txHash, reason: mismatch.join(',') }
  }
  if (receipt?.status === 'reverted') {
    const updated = await db.from('vyr_epoch_distributions').update({ status: 'failed', published: false }).eq('id', snapshot.id).select('*').single()
    if (updated.error) throw updated.error
    return { status: 'failed', txHash, reason: 'VYR_PUBLISH_REVERTED' }
  }
  return { status: 'publishing', txHash, reason: 'RECEIPT_UNAVAILABLE' }
}

/**
 * FINDING (high, corregido en esta migracion): el cuerpo de la funcion aceptaba
 * `arena?: number` y lo usaba al validar el calldata, pero las dos lecturas on-chain
 *会用 `args: [0, ...]` hardcodeado. Consecuencia con mas de una arena: un `claim` de MEDIUM
 * pasaba la validacion de calldata como MEDIUM y despues se consultaba `claimed` en la arena
 * HUMAN, que nunca habia sido reclamada, asi que el claim se quedaba en 'pending' para
 * siempre. La arena es ahora un parametro obligatorio y se usa en las tres lecturas.
 */
export async function reconcileVyrClaim(input: { arena: ArenaId; epoch: bigint; wallet: Address; txHash: Hex }, requestId = crypto.randomUUID()) {
  const distributorAddress = VYNAR_REWARDS_V3_ADDRESS
  if (!distributorAddress) return { status: 'unknown' as const, reason: 'VYNAR_REWARDS_NOT_CONFIGURED' }
  const env = getServerEnv()
  try {
    const [tx, receipt] = await Promise.all([
      withRpcRead('vyr.claim.tx', requestId, (client) => client.getTransaction({ hash: input.txHash })),
      waitForConfirmation(input.txHash, requestId),
    ])
    if (tx.to?.toLowerCase() !== distributorAddress.toLowerCase()) return { status: 'invalid' as const, reason: 'CLAIM_TX_DESTINATION_MISMATCH' }
    if (tx.from.toLowerCase() !== input.wallet.toLowerCase()) return { status: 'invalid' as const, reason: 'CLAIM_TX_SENDER_MISMATCH' }
    if (tx.chainId !== env.chainId) return { status: 'invalid' as const, reason: 'CLAIM_TX_CHAIN_MISMATCH' }
    const calldataError = validateVyrClaimCalldata(tx.input, { arena: input.arena, epoch: input.epoch })
    if (calldataError) return { status: 'invalid' as const, reason: calldataError }
    if (receipt.status !== 'success') return { status: 'failed' as const, reason: 'CLAIM_TX_REVERTED' }
    const claimed = await withRpcRead('vyr.claimed', requestId, (client) => client.readContract({ address: distributorAddress, abi: vynarRewardsV3Abi, functionName: 'claimed', args: [input.arena, input.epoch, getAddress(input.wallet)] }))
    return claimed ? { status: 'confirmed' as const } : { status: 'pending' as const, reason: 'CLAIM_NOT_CONFIRMED_ONCHAIN' }
  } catch { return { status: 'pending' as const } }
}
