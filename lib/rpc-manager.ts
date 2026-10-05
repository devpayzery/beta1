import 'server-only'

import { createPublicClient, http, type PublicClient } from 'viem'
import { getServerEnv } from '@/lib/server-env'

export type RpcHealthStatus = 'healthy' | 'degraded' | 'cooldown'

type RpcState = {
  url: string
  status: RpcHealthStatus
  failureCount: number
  successCount: number
  lastFailureAt?: number
  lastSuccessAt?: number
  cooldownUntil?: number
  lastLatencyMs?: number
}

type RpcOperation<T> = (client: PublicClient) => Promise<T>

const states = new Map<string, RpcState>()
let selectionCursor = 0

function getStates(): RpcState[] {
  const urls = getServerEnv().rpcUrls
  return urls.map((url) => {
    const current = states.get(url)
    if (current) return current
    const created: RpcState = { url, status: 'healthy', failureCount: 0, successCount: 0 }
    states.set(url, created)
    return created
  })
}

function logRpc(requestId: string, operation: string, state: RpcState, attempt: number, result: string, latencyMs: number, errorType?: string) {
  console.error(JSON.stringify({ event: 'rpc.failover', requestId, operation, rpcIndex: getStates().indexOf(state) + 1, rpcHost: new URL(state.url).host, attempt, latencyMs, result, ...(errorType ? { errorType } : {}) }))
}

function eligible(statesToUse: RpcState[], now: number) {
  const available = statesToUse.filter((state) => state.status !== 'cooldown' || !state.cooldownUntil || state.cooldownUntil <= now)
  return available.length > 0 ? available : statesToUse
}

function ordered(statesToUse: RpcState[]) {
  const start = selectionCursor++ % statesToUse.length
  return statesToUse.slice(start).concat(statesToUse.slice(0, start))
}

function markSuccess(state: RpcState, latencyMs: number) {
  state.failureCount = 0
  state.successCount += 1
  state.lastSuccessAt = Date.now()
  state.lastLatencyMs = latencyMs
  state.status = 'healthy'
  state.cooldownUntil = undefined
}

function markFailure(state: RpcState, latencyMs: number) {
  state.failureCount += 1
  state.lastFailureAt = Date.now()
  state.lastLatencyMs = latencyMs
  state.status = state.failureCount >= getServerEnv().rpcFailureThreshold ? 'cooldown' : 'degraded'
  if (state.status === 'cooldown') state.cooldownUntil = Date.now() + getServerEnv().rpcCooldownMs
}

export function rpcHealthSnapshot() {
  return getStates().map((state) => ({ ...state }))
}

export async function withRpcRead<T>(operation: string, requestId: string, action: RpcOperation<T>, deadlineAt = Date.now() + getServerEnv().rpcDeadlineMs): Promise<T> {
  const candidates = ordered(eligible(getStates(), Date.now()))
  let lastError: unknown
  for (const [index, state] of candidates.entries()) {
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0) throw new Error('RPC_DEADLINE_EXCEEDED')
    const started = Date.now()
    const client = createPublicClient({ chain: rpcChainConfig(), transport: http(state.url, { timeout: Math.min(getServerEnv().rpcTimeoutMs, remainingMs) }) })
    try {
      const result = await action(client)
      const latencyMs = Date.now() - started
      markSuccess(state, latencyMs)
      logRpc(requestId, operation, state, index + 1, 'success', latencyMs)
      return result
    } catch (error) {
      const latencyMs = Date.now() - started
      lastError = error
      markFailure(state, latencyMs)
      const errorType = error instanceof Error && /timeout/i.test(error.message) ? 'timeout' : 'rpc_error'
      logRpc(requestId, operation, state, index + 1, 'failure', latencyMs, errorType)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('CHAIN_UNAVAILABLE')
}

export function rpcChainConfig() {
  const env = getServerEnv()
  return { id: env.chainId, name: 'SVP Chain Testnet', nativeCurrency: { name: 'SVP', symbol: 'SVP', decimals: 18 }, rpcUrls: { default: { http: env.rpcUrls } } } as const
}

export function selectWriteRpc() {
  return ordered(eligible(getStates(), Date.now()))[0]
}

export function reportWriteResult(state: RpcState, success: boolean, latencyMs: number) {
  if (success) markSuccess(state, latencyMs)
  else markFailure(state, latencyMs)
}
