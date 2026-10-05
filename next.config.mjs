/**
 * Content-Security-Policy for the arcade.
 *
 * AUDIT FIX: the previous header was `Content-Security-Policy-Report-Only`, so nothing was
 * enforced, and its directives allowed `'unsafe-inline'` *and* `'unsafe-eval'` in `script-src` —
 * which defeats the entire purpose of a CSP even when it is enforcing. This header is now a real
 * `Content-Security-Policy`.
 *
 * Why the directives look the way they do:
 *
 * - `script-src` keeps `'unsafe-inline'` because Next.js 16 App Router emits inline bootstrap
 *   scripts, and nonce injection requires a per-request dynamic rendering path that this static
 *   `headers()` config cannot provide. `'unsafe-eval'` is gone: it is a dev-only requirement and
 *   was the single most damaging token in the old policy.
 * - `object-src 'none'`, `base-uri 'self'` and `frame-ancestors 'none'` are the three directives the
 *   old policy omitted and that actually constrain injection.
 * - `connect-src` is narrowed from `https:` to the hosts this app really talks to.
 * - `form-action 'self'` stops an injected form posting credentials off-origin.
 *
 * Closing the `'unsafe-inline'` gap properly means per-request nonces (see the Next.js CSP guide);
 * that is tracked separately rather than pretended here.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  // Inline bootstrap + Next.js runtime chunks. See note above about 'unsafe-inline'.
  "script-src 'self' 'unsafe-inline'",
  // Tailwind and React inject style attributes at runtime, so style-src cannot drop 'unsafe-inline'.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Chain RPC, Supabase and wallet/analytics endpoints. Any host added here widens the XSS
  // exfiltration channel, so keep this list as tight as the deployed set allows.
  "connect-src 'self' https://*.svpchain.org https://*.supabase.co wss://*.supabase.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ')

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      { key: 'Content-Security-Policy', value: contentSecurityPolicy },
      // Kept alongside the enforcing policy so violations are observable without loosening it.
      { key: 'Content-Security-Policy-Report-Only', value: `${contentSecurityPolicy}; report-to=csp-endpoint` },
    ] }]
  },
}

export default nextConfig