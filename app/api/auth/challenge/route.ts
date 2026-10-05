import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { apiError } from '@/lib/arcade-types'
import { consumeLimit, rateLimitResponse, requestIp } from '@/lib/rate-limit'
import { issueChallenge } from '@/lib/wallet-auth'
import { logOperationalError } from '@/lib/server-log'

export const runtime = 'nodejs'

/**
 * Issues a single-use challenge message for the caller to sign with their wallet.
 * The response is per-wallet-IP limited so the nonce table cannot be filled by one abusive client.
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID()
  let ipLimit
  try { ipLimit = await consumeLimit('auth_ip', requestIp(request)) } catch (error) {
    logOperationalError('auth.challenge.rate_limit', requestId, error)
    return apiError('CHAIN_UNAVAILABLE', 'Request controls are unavailable.', 503, requestId)
  }
  if (!ipLimit.allowed) return rateLimitResponse(requestId, ipLimit.retryAfter)
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return apiError('INVALID_JSON', 'Content-Type debe ser application/json.', 415, requestId)
  // Parsed outside the operational try: a malformed body is a client error (400), not a server fault,
  // and reporting it as 503 would tell the caller to retry something that can never succeed.
  let body: unknown
  try { body = await request.json() } catch { return apiError('INVALID_JSON', 'El cuerpo no es JSON válido.', 400, requestId) }
  const wallet = (body as Record<string, unknown>).wallet
  if (typeof wallet !== 'string' || !isAddress(wallet)) return apiError('INVALID_WALLET', 'The wallet parameter is invalid.', 400, requestId)
  try {
    const challenge = await issueChallenge(wallet)
    return NextResponse.json({ ...challenge, requestId }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    logOperationalError('auth.challenge', requestId, error)
    return apiError('CHALLENGE_UNAVAILABLE', 'We could not start the sign-in challenge.', 503, requestId)
  }
}