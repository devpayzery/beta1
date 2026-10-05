'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'

/**
 * Wallet sign-in for the endpoints that expose per-wallet data.
 *
 * AUDIT FIX: /api/history, /api/incentive/my-rewards, /api/incentive/rewards and
 * /api/incentive/claim-status used to accept a self-asserted `?wallet=` parameter and read through
 * the service-role client, so anyone could read any address's rewards and score history by editing
 * one query parameter. Those endpoints now require an httpOnly session cookie scoped to the
 * signing wallet (see lib/wallet-auth.ts).
 *
 * This hook runs the handshake: request a single-use challenge, sign it, redeem it for the cookie.
 * It signs once per (address, chain) pair and does nothing while signed out.
 */

export type SignInStatus = 'signed_out' | 'signing' | 'signed_in' | 'error'

export function useWalletSignIn() {
  const { address, isConnected, chainId } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [status, setStatus] = useState<SignInStatus>('signed_out')
  // Guards against the effect re-running the handshake for the same account while it is in flight.
  const inFlightRef = useRef<string | null>(null)
  const lastAccountRef = useRef<string | null>(null)

  const signIn = useCallback(async (target: string) => {
    if (inFlightRef.current === target) return
    inFlightRef.current = target
    setStatus('signing')
    try {
      const challengeResponse = await fetch('/api/auth/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: target }),
      })
      if (!challengeResponse.ok) throw new Error('challenge_failed')
      const challenge = await challengeResponse.json() as { message?: string; nonce?: string; issuedAt?: number }
      if (typeof challenge.message !== 'string' || typeof challenge.nonce !== 'string' || typeof challenge.issuedAt !== 'number') {
        throw new Error('challenge_malformed')
      }
      const signature = await signMessageAsync({ message: challenge.message })
      const sessionResponse = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: target, nonce: challenge.nonce, issuedAt: challenge.issuedAt, signature }),
      })
      if (!sessionResponse.ok) throw new Error('session_failed')
      setStatus('signed_in')
    } catch (error) {
      // Never surface wallet internals or the challenge contents to the console.
      console.warn('[arcade] wallet sign-in did not complete', error instanceof Error ? error.message : 'unknown')
      setStatus('error')
    } finally {
      inFlightRef.current = null
    }
  }, [signMessageAsync])

  useEffect(() => {
    if (!isConnected || !address || chainId !== 2517) {
      lastAccountRef.current = null
      setStatus('signed_out')
      return
    }
    const target = address.toLowerCase()
    if (lastAccountRef.current === target) return
    lastAccountRef.current = target
    void signIn(target)
  }, [isConnected, address, chainId, signIn])

  return { status, signIn, isSignedIn: status === 'signed_in' }
}