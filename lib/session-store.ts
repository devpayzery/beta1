import 'server-only'
import { randomBytes } from 'node:crypto'
import type { Address, Hex } from 'viem'
import { keccak256, stringToBytes } from 'viem'
import { createAdminClient } from '@/lib/supabase/admin'
import type { ArcadeSession, SessionStatus } from '@/lib/arcade-types'
import type { ArenaType } from '@/lib/arcade-arenas'

export const SESSION_TTL_MS = 60_000
// The server validates gameplay evidence, but the current contract does not cryptographically prove gameplay execution.

function mapSession(row: Record<string, unknown>): ArcadeSession {
  // La columna es `text` con check de 4 valores, pero el tipo de TS solo puede afirmar lo que la
  // base garantiza. `arenaByType` no puede validar esto porque devuelve undefined para un valor
  // desconocido, y un `as` directo seria la clase de desincronizacion que 20261002000000 vino a
  // arreglar. La columna tiene NOT NULL y check, asi que el caso invalido no puede llegar aqui.
  return { arena: String(row.arena_type) as ArenaType, sessionId: String(row.session_id), wallet: String(row.wallet) as Address, paymentId: String(row.payment_id), epoch: BigInt(String(row.epoch)), gameSeed: String(row.game_seed) as Hex, status: String(row.status) as SessionStatus, score: row.score === null ? null : Number(row.score), expiresAt: String(row.expires_at) }
}

export async function findPaymentByTxHash(txHash: string) {
  const { data, error } = await createAdminClient().from('arcade_payments').select('*').eq('tx_hash', txHash).maybeSingle()
  if (error) throw error
  return data
}

export async function findSessionByPaymentId(paymentId: string): Promise<ArcadeSession | null> {
  const { data, error } = await createAdminClient().from('arcade_sessions').select('*').eq('payment_id', paymentId).maybeSingle()
  if (error) throw error
  return data ? mapSession(data) : null
}

export async function reconcilePaymentToSession(input: { txHash: string; epoch: bigint }): Promise<ArcadeSession> {
  const payment = await findPaymentByTxHash(input.txHash)
  if (!payment || payment.status !== 'verified') throw new Error('Payment is not verified')
  const existing = await findSessionByPaymentId(String(payment.id))
  if (existing) return existing
  try {
    // El modo sale del PAGO, no de un parametro de la peticion. Es la unica fuente que ya esta
    // grabada y verificada contra la cadena: si el llamante impusiera el modo, la sesion seria
    // distinta del pago que la compro, y el score de MEDIUM se pagaria como HARD.
    return await createSession({ wallet: String(payment.wallet) as Address, paymentId: String(payment.id), epoch: input.epoch, arena: String(payment.arena_type ?? 'human') as ArenaType })
  } catch (error) {
    const recovered = await findSessionByPaymentId(String(payment.id))
    if (recovered) return recovered
    throw error
  }
}

export async function createSession(input: { wallet: Address; paymentId: string; epoch: bigint; arena: ArenaType }): Promise<ArcadeSession> {
  const sessionId = `0x${randomBytes(32).toString('hex')}`
  const gameSeed = keccak256(stringToBytes(`${sessionId}:${input.wallet}:${Date.now()}:${randomBytes(16).toString('hex')}`))
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  const { data, error } = await createAdminClient().from('arcade_sessions').insert({ session_id: sessionId, wallet: input.wallet, payment_id: input.paymentId, arena_type: input.arena, epoch: input.epoch.toString(), game_seed: gameSeed, status: 'active', expires_at: expiresAt }).select('*').single()
  if (error || !data) throw error ?? new Error('Session was not created')
  return mapSession(data)
}

export async function getSession(sessionId: string): Promise<ArcadeSession | null> {
  const { data, error } = await createAdminClient().from('arcade_sessions').select('*').eq('session_id', sessionId).maybeSingle()
  if (error) throw error
  return data ? mapSession(data) : null
}

export async function transitionSession(sessionId: string, from: SessionStatus, to: SessionStatus, extra: Record<string, unknown> = {}): Promise<boolean> {
  const { data, error } = await createAdminClient().from('arcade_sessions').update({ status: to, ...extra }).eq('session_id', sessionId).eq('status', from).select('session_id').maybeSingle()
  if (error) throw error
  return Boolean(data)
}
