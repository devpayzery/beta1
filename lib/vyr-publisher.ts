import 'server-only'

import { createWalletClient, http, getAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createAdminClient } from '@/lib/supabase/admin'
import { arenaById, type ArenaId } from '@/lib/arcade-arenas'
import { vynarAbi, VYNAR_REWARDS_V3_ADDRESS } from '@/lib/vynar-config'
import { vynarRewardsV3Abi } from '@/lib/vynar-rewards-v3-abi'
import { selectWriteRpc, reportWriteResult, withRpcRead } from '@/lib/rpc-manager'
import { chainConfig, waitForConfirmation } from '@/lib/server-blockchain'
import { getServerEnv, VYR_EPOCH_POOL_WEI, VYR_PERCENTAGES } from '@/lib/server-env'
import { finalizeVyrEpoch } from '@/lib/reward-finalization'

const MAX_WINNERS = 10

// The deployed ABI exposes uint256[] only; the contract source is not present in this repo.
// Therefore publication is fail-closed until the operator explicitly validates 100 or 10000.
function configuredPercentages(): bigint[] {
  if (VYR_PERCENTAGES.length !== MAX_WINNERS || VYR_PERCENTAGES.reduce((sum, value) => sum + value, BigInt(0)) !== BigInt(10000)) throw new Error('VYR_PERCENTAGES_INVALID')
  return [...VYR_PERCENTAGES]
}

function sameAddresses(actual: readonly Address[], expected: readonly Address[]) {
  return actual.length === expected.length && actual.every((address, index) => address.toLowerCase() === expected[index].toLowerCase())
}

/**
 * Estado de la epoch leido de VynarRewardsV3, DESESTRUCTURADO POR NOMBRE.
 *
 * Antes se leia con `info[0]`, `info[5]`, `info[7]`. Los outputs estan nombrados en el ABI y
 * borrarlos no cuesta nada: lo que importa es que un indice equivocado se note al revisar, y
 * `info[7]` no dice nada sobre ser `canceled`.
 */
async function readState(address: Address, epoch: bigint, arena: ArenaId, requestId: string) {
  const [info, percentages, winners] = await Promise.all([
    withRpcRead('vyr.getEpochInfo', requestId, (client) => client.readContract({ address, abi: vynarRewardsV3Abi, functionName: 'getEpochInfo', args: [arena, epoch] })),
    withRpcRead('vyr.getPercentages', requestId, (client) => client.readContract({ address, abi: vynarRewardsV3Abi, functionName: 'getPercentages', args: [arena, epoch] })),
    withRpcRead('vyr.getWinners', requestId, (client) => client.readContract({ address, abi: vynarRewardsV3Abi, functionName: 'getWinners', args: [arena, epoch] })),
  ])
  const [pool, positionCount, , totalClaimed, settledAt, funded, settled, canceled] = info
  return { pool, positionCount, totalClaimed, settledAt, funded, settled, canceled, percentages, winners }
}

export async function publishVyrEpoch(epoch: bigint, arena: ArenaId, requestId = crypto.randomUUID()) {
  const arenaConfig = arenaById(arena)
  if (!arenaConfig) throw new Error('UNKNOWN_ARENA')
  const rewardsAddress = VYNAR_REWARDS_V3_ADDRESS
  if (!rewardsAddress) throw new Error('VYNAR_REWARDS_V3_ADDRESS_NOT_CONFIGURED')
  const finalization = await finalizeVyrEpoch(epoch, arena, requestId)
  const winners = finalization.top10.map((player) => getAddress(player.wallet))
  if (winners.length < 1 || winners.length > MAX_WINNERS || new Set(winners.map((winner) => winner.toLowerCase())).size !== winners.length) throw new Error('VYR_WINNERS_INVALID')
  const pool = VYR_EPOCH_POOL_WEI
  const expectedPercentages = configuredPercentages()
  const basis = await withRpcRead('vyr.BASIS', requestId, (client) => client.readContract({ address: rewardsAddress, abi: vynarRewardsV3Abi, functionName: 'BASIS' }))
  if (basis !== BigInt(10000)) throw new Error('VYR_BASIS_MISMATCH')
  const initial = await readState(rewardsAddress, epoch, arena, requestId)
  if (initial.canceled) throw new Error('VYR_EPOCH_CANCELLED')
  const db = createAdminClient()
  const snapshotId = finalization.snapshot.id
  const write = selectWriteRpc()
  const account = privateKeyToAccount(getServerEnv().privateKey)
  const wallet = createWalletClient({ account, chain: chainConfig(), transport: http(write.url, { timeout: getServerEnv().rpcTimeoutMs }) })
  const [owner, signer, tokenAddress] = await Promise.all([
    withRpcRead('vyr.owner', requestId, (client) => client.readContract({ address: rewardsAddress, abi: vynarRewardsV3Abi, functionName: 'owner' })),
    withRpcRead('vyr.signer', requestId, (client) => client.readContract({ address: rewardsAddress, abi: vynarRewardsV3Abi, functionName: 'signer' })),
    withRpcRead('vyr.vynarToken', requestId, (client) => client.readContract({ address: rewardsAddress, abi: vynarRewardsV3Abi, functionName: 'vynarToken' })),
  ])
  if (owner.toLowerCase() !== account.address.toLowerCase() && initial.pool === BigInt(0)) throw new Error(`VYR_OWNER_MISMATCH:${owner}:${account.address}`)
  const funded = await withRpcRead('vyr.balanceOf', requestId, (client) => client.readContract({ address: tokenAddress, abi: vynarAbi, functionName: 'balanceOf', args: [rewardsAddress] }))
  if (funded < pool) throw new Error('VYR_POOL_NOT_FUNDED')
  let openTxHash: Hex | null = null
  let winnersTxHash: Hex | null = null
  const opened = initial.pool === pool && initial.funded && initial.positionCount === BigInt(winners.length)
  if (!opened) {
    if (initial.pool !== BigInt(0) && initial.pool !== pool) throw new Error('VYR_ONCHAIN_POOL_MISMATCH')
    try {
      openTxHash = await wallet.writeContract({ address: rewardsAddress, abi: vynarRewardsV3Abi, functionName: 'openEpoch', args: [arena, epoch, pool, expectedPercentages], account })
      const receipt = await waitForConfirmation(openTxHash, requestId)
      if (receipt.status !== 'success') throw new Error('VYR_OPEN_REVERTED')
      reportWriteResult(write, true, 0)
    } catch (error) {
      reportWriteResult(write, false, 0)
      const recovered = await readState(rewardsAddress, epoch, arena, requestId)
      if (recovered.pool !== pool || recovered.canceled || !recovered.funded) throw error
    }
  }
  const afterOpen = await readState(rewardsAddress, epoch, arena, requestId)
  if (afterOpen.pool !== pool || afterOpen.canceled || afterOpen.positionCount !== BigInt(winners.length) || afterOpen.percentages.length !== expectedPercentages.length || afterOpen.percentages.some((value, index) => value !== expectedPercentages[index])) throw new Error('VYR_OPEN_STATE_MISMATCH')
  if (afterOpen.winners.length > 0) {
    if (!sameAddresses(afterOpen.winners, winners)) { await db.from('vyr_chain_snapshots').update({ status: 'mismatch' }).eq('id', snapshotId); throw new Error('VYR_ONCHAIN_WINNERS_MISMATCH') }
  } else {
    if (signer.toLowerCase() !== account.address.toLowerCase()) throw new Error(`VYR_SIGNER_MISMATCH:${signer}:${account.address}`)
    try {
      winnersTxHash = await wallet.writeContract({ address: rewardsAddress, abi: vynarRewardsV3Abi, functionName: 'submitWinners', args: [arena, epoch, winners], account })
      const receipt = await waitForConfirmation(winnersTxHash, requestId)
      if (receipt.status !== 'success') throw new Error('VYR_SUBMIT_REVERTED')
      reportWriteResult(write, true, 0)
    } catch (error) {
      reportWriteResult(write, false, 0)
      const recovered = await readState(rewardsAddress, epoch, arena, requestId)
      if (!sameAddresses(recovered.winners, winners)) throw error
    }
  }
  const finalState = await readState(rewardsAddress, epoch, arena, requestId)
  if (!sameAddresses(finalState.winners, winners)) throw new Error('VYR_ONCHAIN_WINNERS_MISMATCH')
  await db.from('vyr_chain_snapshots').update({ status: 'confirmed', open_tx_hash: openTxHash, winners_tx_hash: winnersTxHash }).eq('id', snapshotId)
  return { status: 'confirmed' as const, epoch: epoch.toString(), arena, arenaType: arenaConfig.type, pool: pool.toString(), winners, openTxHash, winnersTxHash }
}