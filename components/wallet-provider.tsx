'use client'

import React, { useEffect, useState } from 'react'
import { defineChain } from 'viem'
import { createConfig, http, WagmiProvider } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const svpChain = defineChain({
  id: 2517,
  name: 'SVP Chain Testnet',
  nativeCurrency: { name: 'SVP', symbol: 'SVP', decimals: 18 },
  rpcUrls: { default: { http: ['https://svp-dataseed1-testnet.svpchain.org'] } },
  blockExplorers: { default: { name: 'Explorer', url: 'https://explorer.svpchain.com' } },
  testnet: true,
})

const config = createConfig({
  chains: [svpChain],
  connectors: [injected()],
  transports: {
    [svpChain.id]: http(),
  },
  ssr: true,
})

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: 15_000 } } })

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {mounted ? children : null}
      </QueryClientProvider>
    </WagmiProvider>
  )
}
