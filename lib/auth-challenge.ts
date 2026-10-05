/**
 * Wallet-provenance challenge protocol.
 *
 * FINDING (critical, remediated): the per-wallet read endpoints used to trust a self-asserted
 * `?wallet=` query parameter and read through the service-role client, which bypasses RLS. This
 * module is the pure half of the fix: it builds and parses the challenge message that a wallet
 * signs, and extracts the fields needed to decide whether a signature is acceptable.
 *
 * It is deliberately free of `server-only`, environment and database imports so it can be exercised
 * by `tests/arcade.test.ts` — see the AGENTS.md note that vitest cannot import server-only modules.
 */

export const AUTH_DOMAIN = 'verityarcade.arcade'
export const CHALLENGE_TTL_SECONDS = 300
export const AUTH_CHALLENGE_PREFIX = 'verityarcade wants you to sign in with your Ethereum account:'
export const AUTH_INTENT = 'Sign in to Verity Arcade to view your rewards and score history. This request does not trigger a blockchain transaction or cost any gas.'

export type AuthChallenge = { wallet: string; nonce: string; issuedAt: number }

function line(value: string): string {
  // SIWE field rules: no newlines, no leading/trailing whitespace that would break the canonical form.
  return value.replace(/[\r\n]+/g, ' ').trim()
}

export function buildAuthMessage(input: { wallet: string; nonce: string; issuedAt: number }): string {
  const uri = line(`https://${AUTH_DOMAIN}`)
  const issued = new Date(input.issuedAt * 1000).toISOString()
  return [
    `${AUTH_CHALLENGE_PREFIX}`,
    `${input.wallet}`,
    '',
    line(AUTH_INTENT),
    '',
    `URI: ${uri}`,
    `Version: 1`,
    `Chain ID: 2517`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${issued}`,
  ].join('\n')
}

export function createNonce(): string {
  // 16 random bytes as hex. crypto is available in both Node and the browser runtimes used here.
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function isValidNonce(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-f]{32}$/.test(value)
}

export function isValidChallengeWallet(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

/**
 * Re-derives the expected message from client-supplied fields so the server verifies a signature
 * over a message it built itself, rather than over whatever text the client handed back.
 */
export function expectedMessageFromRequest(input: { wallet: string; nonce: string; issuedAt: number }): string {
  return buildAuthMessage({ wallet: input.wallet, nonce: input.nonce, issuedAt: input.issuedAt })
}

/**
 * Checks the age of a challenge before any signature verification work is done.
 * `maxAgeSeconds` defaults to CHALLENGE_TTL_SECONDS; a small negative skew tolerance keeps a
 * correct client from failing because of a slightly fast clock.
 */
export function isChallengeFresh(issuedAt: number, nowMs: number, maxAgeSeconds = CHALLENGE_TTL_SECONDS): boolean {
  if (!Number.isFinite(issuedAt) || !Number.isFinite(nowMs)) return false
  const ageSeconds = (nowMs - issuedAt * 1000) / 1000
  return ageSeconds > -30 && ageSeconds <= maxAgeSeconds
}