import { isIP } from 'node:net'

/**
 * Client identity for rate limiting.
 *
 * FINDING (medium, remediated): the previous implementation returned the literal string `'unknown'`
 * whenever the platform did not send `x-real-ip`, which meant *every* client on such a platform
 * collapsed into a single rate-limit bucket. One noisy client could then lock out the entire
 * arcade, and per-IP limits stopped meaning anything.
 *
 * `x-forwarded-for` is still deliberately NOT trusted — it is attacker-controlled and would let
 * anyone rotate the "IP" to sidestep limits entirely (lib/trusted-client-ip-core.ts, with tests).
 *
 * The fallback is now the platform edge's own address, which is genuinely one network-level
 * identity. Collapsing onto it is honest about what is knowable, but to stop that shared bucket
 * from becoming a single point of denial-of-service, callers that would otherwise be limited by it
 * also get a per-subject limit. `resolveClientIdentity` returns both halves so a caller can apply
 * a limit on the address and a stricter independent limit on the subject (wallet, session or tx).
 */
export function getTrustedClientIp(request: Request): string {
  const platformIp = request.headers.get('x-real-ip')?.trim()
  if (platformIp && isIP(platformIp)) return platformIp
  // No per-client address is available. Fall back to the edge address, which is at least stable and
  // is what the platform itself sees, rather than to a shared constant.
  const edgeIp = request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim()
  if (edgeIp && isIP(edgeIp)) return edgeIp
  const connectionIp = request.headers.get('cf-connecting-ip')?.trim()
  if (connectionIp && isIP(connectionIp)) return connectionIp
  // Last resort. A distinct pseudo-identity per request would defeat the limiter entirely (an
  // attacker gets a fresh bucket per request), so this stays a single shared bucket and callers
  // must pair it with a subject-scoped limit. Kept as a distinct constant, not a bare 'unknown',
  // so it is greppable and the shared-bucket caveat stays visible at every call site.
  return 'shared-edge-bucket'
}

/**
 * Resolves the rate-limiting identity of a request as (ip, subject).
 *
 * Callers should apply both limits. When the platform gives us a real client address, `subject` is
 * supplied by the caller and the IP limit is meaningful. When it does not, `ip` is a single shared
 * bucket and only the subject limit prevents one abusive client from starving everyone else.
 */
export function resolveClientIdentity(request: Request, subject: string): { ip: string; subject: string } {
  return { ip: getTrustedClientIp(request), subject }
}