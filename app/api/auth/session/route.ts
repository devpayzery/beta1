import { NextResponse } from 'next/server'
import { apiError } from '@/lib/arcade-types'
import { consumeLimit, rateLimitResponse, requestIp } from '@/lib/rate-limit'
import { authRequestValidationError, clearSessionCookieHeader, redeemChallenge, sessionCookieHeader, createSessionToken, type AuthRequest } from '@/lib/wallet-auth'
import { logOperationalError } from '@/lib/server-log'

export const runtime = 'nodejs'

/**
 * Redeems a signed challenge for an httpOnly session cookie scoped to the signing wallet.
 * The cookie is the only thing standing between an anonymous caller and another address's
 * reward and history data, so failure modes fail closed.
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID()
  let ipLimit
  try { ipLimit = await consumeLimit('auth_ip', requestIp(request)) } catch (error) {
    logOperationalError('auth.session.rate_limit', requestId, error)
    return apiError('CHAIN_UNAVAILABLE', 'Request controls are unavailable.', 503, requestId)
  }
  if (!ipLimit.allowed) return rateLimitResponse(requestId, ipLimit.retryAfter)
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return apiError('INVALID_JSON', 'Content-Type debe ser application/json.', 415, requestId)
  let body: unknown
  try { body = await request.json() } catch { return apiError('INVALID_JSON', 'El cuerpo no es JSON válido.', 400, requestId) }
  const validationError = authRequestValidationError(body)
  if (validationError) return apiError('INVALID_CHALLENGE', 'The sign-in challenge is invalid.', 400, requestId)
  const input = body as AuthRequest
  try {
    const result = await redeemChallenge(input)
    if (!result.ok) {
      // 401 for every failure mode: distinguishing them would let a caller probe which nonces exist.
      return apiError('UNAUTHENTICATED', 'The signature could not be verified.', 401, requestId)
    }
    const token = createSessionToken(input.wallet)
    return NextResponse.json({ status: 'authenticated', wallet: input.wallet.toLowerCase(), requestId }, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookieHeader(token) } })
  } catch (error) {
    logOperationalError('auth.session.redeem', requestId, error)
    return apiError('SIGN_IN_UNAVAILABLE', 'We could not complete the sign-in.', 503, requestId)
  }
}

/** Signs the current browser out of the wallet session. */
export async function DELETE() {
  return NextResponse.json({ status: 'signed_out' }, { headers: { 'Cache-Control': 'no-store', 'Set-Cookie': clearSessionCookieHeader() } })
}