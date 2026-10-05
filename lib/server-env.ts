import 'server-only'
import { getAddress, isAddress, parseEther } from 'viem'
import { ARCADE_ENTRY_FEE, SVP_CHAIN_ID } from '@/lib/arcade-config'
import { HUMAN_ENTRY_FEE } from '@/lib/arcade-arenas'

export { ARCADE_ENTRY_FEE, SVP_CHAIN_ID }
export const INITIAL_ENTRY_FEE = ARCADE_ENTRY_FEE
export const PRODUCTION_EPOCH_DURATION = 86_400
export const TESTING_EPOCH_DURATION = 1_200
export const INITIAL_EPOCH_DURATION = process.env.APP_ENV === 'production' ? PRODUCTION_EPOCH_DURATION : TESTING_EPOCH_DURATION
export const ENTRY_CUTOFF_SECONDS = 300
export const MINIMUM_GAME_SECONDS = 30
export const VYR_EPOCH_POOL_VYR = BigInt(10000)
export const VYR_EPOCH_POOL_WEI = VYR_EPOCH_POOL_VYR * BigInt('1000000000000000000')
export const VYR_PERCENTAGES = [BigInt(3500), BigInt(2000), BigInt(1200), BigInt(800), BigInt(600), BigInt(500), BigInt(400), BigInt(400), BigInt(300), BigInt(300)] as const

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required server environment variable: ${name}`)
  return value
}

export function getSupabaseEnv() {
  return {
    supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  }
}

export function getServerEnv() {
  // FINDING (medium, remediated): APP_ENV (server, this file) and NEXT_PUBLIC_APP_ENV (client,
  // lib/arcade-config.ts) both select the epoch duration — 86400s vs 1200s — and nothing checked
  // that they agreed. Setting only one produced a client that computed a different epoch boundary
  // from the server, so the entry gate opened or closed at the wrong time. The client value is
  // inlined at build time and cannot be read at runtime on the server, so agreement is asserted
  // here and fails the app loudly rather than diverging quietly.
  const serverEnvName = process.env.APP_ENV
  const clientEnvName = process.env.NEXT_PUBLIC_APP_ENV
  if (serverEnvName !== clientEnvName) throw new Error(`APP_ENV (${serverEnvName ?? 'unset'}) and NEXT_PUBLIC_APP_ENV (${clientEnvName ?? 'unset'}) must be set to the same value: they select the same epoch duration and the client value is baked in at build time`)
  const configuredRpcUrls = (process.env.SVP_RPC_URLS ?? process.env.RPC_URL ?? '').split(',').map((url) => url.trim()).filter(Boolean)
  if (configuredRpcUrls.length < 1 || configuredRpcUrls.some((url) => { try { return new URL(url).protocol !== 'http:' && new URL(url).protocol !== 'https:' } catch { return true } })) throw new Error('SVP_RPC_URLS must contain valid URLs')
  const chainId = Number(required('CHAIN_ID'))
  const vault = required('ARCADE_VAULT_V6_ADDRESS')
  const paymentAmount = required('REQUIRED_PAYMENT_AMOUNT')
  const privateKey = required('GAME_SERVER_PRIVATE_KEY')
  const supabaseUrl = required('NEXT_PUBLIC_SUPABASE_URL')
  const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY')
  const invalidFields: string[] = []
  if (!Number.isSafeInteger(chainId) || chainId !== SVP_CHAIN_ID) invalidFields.push(`CHAIN_ID must be ${SVP_CHAIN_ID}`)
  if (!isAddress(vault)) invalidFields.push('ARCADE_VAULT_V6_ADDRESS must be an EVM address')
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) invalidFields.push('GAME_SERVER_PRIVATE_KEY must be a 32-byte hex key')
  try {
    // REQUIRED_PAYMENT_AMOUNT solo gobierna el precio ANUNCIADO del modo por defecto (human).
    // El importe que la app exige de verdad sale de lib/arcade-arenas.ts y se revalida contra
    // el fee on-chain en verifyPayment(). Con tres modos, una variable global seria el sitio
    // natural donde un precio quedara desincronizado sin que nada lo notara.
    if (parseEther(paymentAmount) !== HUMAN_ENTRY_FEE) invalidFields.push(`REQUIRED_PAYMENT_AMOUNT must be exactly ${ARCADE_ENTRY_FEE} SVP, the human arena fee`)
  } catch {
    invalidFields.push(`REQUIRED_PAYMENT_AMOUNT must be exactly ${ARCADE_ENTRY_FEE} SVP, the human arena fee`)
  }
  if (!supabaseUrl || !serviceRoleKey) invalidFields.push('Supabase server credentials are missing')
  if (invalidFields.length > 0) throw new Error(`Invalid server blockchain environment: ${invalidFields.join('; ')}`)
  const rpcTimeoutMs = Number(process.env.RPC_TIMEOUT_MS ?? 5_000)
  const rpcCooldownMs = Number(process.env.RPC_COOLDOWN_MS ?? 15_000)
  const rpcFailureThreshold = Number(process.env.RPC_FAILURE_THRESHOLD ?? 3)
  const rpcDeadlineMs = Number(process.env.RPC_DEADLINE_MS ?? 12_000)
  if (![rpcTimeoutMs, rpcCooldownMs, rpcFailureThreshold, rpcDeadlineMs].every(Number.isFinite) || rpcTimeoutMs < 500 || rpcCooldownMs < 1000 || rpcFailureThreshold < 2 || rpcDeadlineMs < 1000) throw new Error('Invalid RPC resilience configuration')
  return { rpcUrls: configuredRpcUrls, chainId, vault: getAddress(vault), paymentAmount, privateKey: privateKey as `0x${string}`, supabaseUrl, serviceRoleKey, rpcTimeoutMs, rpcCooldownMs, rpcFailureThreshold, rpcDeadlineMs }
}
