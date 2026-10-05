import 'server-only'

import { createHmac, timingSafeEqual } from 'node:crypto'
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from 'viem'
import { createAdminClient } from '@/lib/supabase/admin'
import { apiError } from '@/lib/arcade-types'
import {
  AUTH_DOMAIN,
  CHALLENGE_TTL_SECONDS,
  buildAuthMessage,
  createNonce,
  expectedMessageFromRequest,
  isChallengeFresh,
  isValidChallengeWallet,
  isValidNonce,
} from '@/lib/auth-challenge'

/**
 * FINDING (critical, remediated): wallet-scoped reads previously trusted a `?wallet=` parameter and
 * went through the service-role client. This module turns "caller claims to own this address" into
 * "caller has signed a single-use, expiring challenge with that address's key", and exposes
 * `requireWalletSession` so a route can refuse to read anything it cannot attribute.
 *
 * Session cookies are HMAC-SHA256 over `wallet.expiry` and carry no privileges beyond "this request
 * is attributable to this wallet", so there is no authorisation decision to make beyond the identity
 * match itself. Everything sensitive is still decided by the session's wallet and the chain.
 */

const COOKIE_NAME = 'verityarcade_session'
const SESSION_TTL_SECONDS = 60 * 60 * 12

function sessionSecret(): string {
  const secret = process.env.WALLET_AUTH_SECRET
  // A missing secret must not degrade to an unsigned cookie, which would be forgeable.
  if (!secret || secret.length < 32) throw new Error('WALLET_AUTH_SECRET must be set to at least 32 characters')
  return secret
}

function sign(payload: string): string {
  return createHmac('sha256', sessionSecret()).update(payload).digest('base64url')
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function createSessionToken(wallet: string, nowMs = Date.now()): string {
  const payload = `${wallet.toLowerCase()}.${Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS}`
  return `${payload}.${sign(payload)}`
}

export function readSessionToken(cookieValue: string | undefined, nowMs = Date.now()): string | null {
  if (!cookieValue) return null
  const parts = cookieValue.split('.')
  if (parts.length !== 3) return null
  const [wallet, expiry, signature] = parts as [string, string, string]
  if (!isAddress(wallet)) return null
  if (!/^\d+$/.test(expiry) || Number(expiry) <= Math.floor(nowMs / 1000)) return null
  if (!constantTimeEquals(signature, sign(`${wallet}.${expiry}`))) return null
  return wallet.toLowerCase()
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {}
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=')
    if (index < 0) return ['', '']
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]
  }).filter(([key]) => key !== ''))
}

export function sessionCookieHeader(token: string): string {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    process.env.NODE_ENV === 'production' ? 'Secure' : '',
  ].filter(Boolean).join('; ')
}

export function clearSessionCookieHeader(): string {
  // Secure is omitted conditionally rather than always, to mirror sessionCookieHeader exactly. It is
  // not part of the cookie identity match (RFC 6265 keys on name/domain/path), so logout works either
  // way -- matching the setter just removes any doubt about the header.
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    process.env.NODE_ENV === 'production' ? 'Secure' : '',
  ].filter(Boolean).join('; ')
}

export function sessionCookieName(): string {
  return COOKIE_NAME
}

/**
 * The identity a request is authenticated as, or null.
 */
export function authenticatedWallet(request: Request): string | null {
  return readSessionToken(parseCookies(request.headers.get('cookie'))[COOKIE_NAME])
}

/**
 * Resolves the wallet a wallet-scoped read is allowed to touch.
 *
 * `requestedWallet` keeps coming from the query string because the client already knows which
 * wallet it is looking at; the point is that it now has to match a signature-verified session.
 * Returns an error response when the caller cannot prove ownership.
 */
export function requireWalletSession(request: Request, requestedWallet: string | null): { wallet: string } | { error: Response } {
  const requestId = crypto.randomUUID()
  if (!requestedWallet || !isAddress(requestedWallet)) {
    return { error: apiError('INVALID_WALLET', 'The wallet parameter is required.', 400, requestId) }
  }
  const normalized = getAddress(requestedWallet).toLowerCase()
  let sessionWallet: string | null
  try {
    sessionWallet = authenticatedWallet(request)
  } catch {
    return { error: apiError('AUTH_UNAVAILABLE', 'Wallet authentication is unavailable.', 503, requestId) }
  }
  if (!sessionWallet) {
    return { error: apiError('UNAUTHENTICATED', 'Sign in with this wallet to view this data.', 401, requestId) }
  }
  if (sessionWallet !== normalized) {
    // Deliberately indistinguishable from "not your data" leaking: 403, no hint about the target.
    return { error: apiError('FORBIDDEN', 'The signed-in wallet does not own the requested data.', 403, requestId) }
  }
  return { wallet: normalized }
}

export async function issueChallenge(wallet: string): Promise<{ message: string; nonce: string; issuedAt: number }> {
  const db = createAdminClient()
  const nonce = createNonce()
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = new Date((issuedAt + CHALLENGE_TTL_SECONDS) * 1000).toISOString()
  // One row per (wallet, nonce); a second challenge for the same wallet is a separate nonce, so a
  // user with two tabs gets two independently usable challenges.
  const inserted = await db.from('arcade_auth_challenges').insert({ wallet: wallet.toLowerCase(), nonce, expires_at: expiresAt })
  if (inserted.error) throw inserted.error
  return { message: buildAuthMessage({ wallet, nonce, issuedAt }), nonce, issuedAt }
}

export type AuthRequest = { wallet: string; nonce: string; issuedAt: number; signature: Hex }

export function authRequestValidationError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'shape'
  const body = value as Record<string, unknown>
  if (!isValidChallengeWallet(body.wallet)) return 'wallet'
  if (!isValidNonce(body.nonce)) return 'nonce'
  if (typeof body.issuedAt !== 'number' || !Number.isInteger(body.issuedAt)) return 'issuedAt'
  if (typeof body.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) return 'signature'
  return null
}

/**
 * Verifies a signature over a message the server rebuilt from its own record of the challenge, and
 * burns the nonce so the signature cannot be replayed.
 */
export async function redeemChallenge(input: AuthRequest): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isChallengeFresh(input.issuedAt, Date.now())) return { ok: false, reason: 'challenge_expired' }
  const message = expectedMessageFromRequest({ wallet: getAddress(input.wallet), nonce: input.nonce, issuedAt: input.issuedAt })
  let signatureValid: boolean
  try {
    signatureValid = await verifyMessage({ address: input.wallet as Address, message, signature: input.signature })
  } catch {
    // Malformed signature input; treat as a failed verification rather than an error.
    signatureValid = false
  }
  if (!signatureValid) return { ok: false, reason: 'signature_mismatch' }
  const db = createAdminClient()
  const { data, error } = await db.rpc('consume_arcade_auth_challenge', { p_wallet: input.wallet.toLowerCase(), p_nonce: input.nonce })
  if (error) throw error
  if (data !== true) return { ok: false, reason: 'challenge_unknown_or_used' }
  return { ok: true }
}

export const AUTH_COOKIE_NAME = COOKIE_NAME
export const AUTH_DOMAIN_NAME = AUTH_DOMAIN