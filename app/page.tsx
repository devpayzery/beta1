import { ArcadeHome } from '@/components/arcade-home'
import { WalletProvider } from '@/components/wallet-provider'

export default function Page() {
  return <WalletProvider><ArcadeHome /></WalletProvider>
}

export const dynamic = 'force-dynamic'

// WalletProvider mounts on /play to keep the landing page lightweight.
// Network configuration lives in components/wallet-provider.tsx.
/* eslint-disable @typescript-eslint/no-unused-vars */
const network = { chainId: 2517, rpc: 'https://svp-dataseed1-testnet.svpchain.org' }
/* eslint-enable @typescript-eslint/no-unused-vars */

