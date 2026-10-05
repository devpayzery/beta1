'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { formatUnits } from 'viem'
import { useAccount, useChainId, useConfig, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { simulateContract, waitForTransactionReceipt } from 'wagmi/actions'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { WalletProvider } from '@/components/wallet-provider'
import { ArenaTabs } from '@/components/arena-tabs'
import { getWeb3ErrorMessage } from '@/lib/play-errors'
import { arcadeVaultV6Abi, arcadeVaultV6Address } from '@/lib/arcade-vault-v6-abi'
import { arenaByType, parseArenaParam } from '@/lib/arcade-arenas'
import { SVP_CHAIN_ID, SVP_EXPLORER_URL, ARCADE_ENTRY_CUTOFF_SECONDS } from '@/lib/arcade-config'
import { VYNAR_REWARDS_V3_ADDRESS, VYNAR_CHAIN_ID } from '@/lib/vynar-config'
import { vynarRewardsV3Abi } from '@/lib/vynar-rewards-v3-abi'
import { useWalletSignIn } from '@/lib/use-wallet-sign-in'

type Entry = { wallet: `0x${string}`; score: string; epoch: string; tx_hash: string | null; created_at: string }
type HistoryEntry = { epoch: string; score: number; tx_hash: string | null; created_at: string }
type PendingClaim = { epoch: bigint; prizePool: bigint; winner: `0x${string}` }

function formatRemaining(seconds: number) {
  const safe = Math.max(0, seconds)
  return `${String(Math.floor(safe / 3600)).padStart(2, '0')}:${String(Math.floor((safe % 3600) / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

function Board() {
  // Modo de la tabla. Todas las lecturas de abajo (`getArenaInfo`, `getEpochResult`, `leaderboard`,
  // `claimed`, `getEpochInfo` y el `claimPrize`) usan `ARENA.id`. Antes iban todas fijas a human:
  // una tabla de medium habria enseñado el podium, el reparto y el estado de reclamo de human, sin
  // ninguna senal de que estaban mezclados. El unico sintoma era que los premios parecian no ser
  // del jugador, y la causa estaba dos mil lineas de la vista.
  const arenaType = parseArenaParam(useSearchParams().get('arena')) ?? 'human'
  const ARENA = arenaByType(arenaType)!
  const { address, isConnected } = useAccount()
  const config = useConfig()
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync, data: claimHash, isPending: claimPending } = useWriteContract()
  const { isSuccess: claimConfirmed } = useWaitForTransactionReceipt({ hash: claimHash })
  const [claimError, setClaimError] = useState<string | null>(null)
  // AUDIT FIX: pendingClaims was declared, read by pendingPrize/visibleClaims, and then reset to []
  // by an effect on every address/epoch/claim change — so it was permanently empty and the only
  // source of visible claims was the on-chain branch. Removed rather than kept as dead state.
  const pendingClaims: PendingClaim[] = []
  const [selectedClaimEpoch, setSelectedClaimEpoch] = useState<bigint | null>(null)
  const [claimStage, setClaimStage] = useState<'idle' | 'simulating' | 'wallet' | 'claiming'>('idle')
  const { isSignedIn } = useWalletSignIn()
  // `getArenaInfo` y no `arenas`: en V6 el getter `arenas` pasa de 9 a 11 outputs y `currentEpoch`
  // sigue en el indice 3 pero los siguientes se desplazan. Leer por nombre no depende de que ese
  // contrato no vuelva a crecer.
  // `getArenaInfo` y no `arenas`: en V6 el getter `arenas` pasa de 9 a 11 outputs y `currentEpoch`
  // sigue en el indice 3 pero los siguientes se desplazan. Leer por posicion, no por el nombre
  // del ABI: viem solo conserva el nombre de una salida si ese identificador aparece en la lista
  // generada de abitype, y para `currentEpoch` y `epochEnd` no aparece. Ver la nota larga en
  // lib/server-blockchain.ts, sobre readArena().
  const { data: rawArena, refetch: refetchArena } = useReadContract({ address: arcadeVaultV6Address, abi: arcadeVaultV6Abi, functionName: 'getArenaInfo', args: [ARENA.id], query: { enabled: Boolean(arcadeVaultV6Address) } })
  // getArenaInfo: [entryFee, protocolFeeBps, epochDuration, currentEpoch, epochStart, epochEnd,
  // pool, active, paused, secondsLeft]. Se desestructura DENTRO del `if` en vez de con `?? []`:
  // un array vacio como fallback tipa cada elemento como `bigint | undefined` y despues hay que
  // Narrowear en cada uso, que es donde un `!` o un `as` se cuelan sin que se note.
  const arena = useMemo(() => {
    if (!rawArena) return undefined
    const [entryFee, protocolFeeBps, epochDuration, currentEpoch, epochStart, epochEnd, pool, active, paused, secondsLeft] = rawArena
    return { entryFee, protocolFeeBps, epochDuration, currentEpoch, epochStart, epochEnd, pool, active, paused, secondsLeft }
  }, [rawArena])
  const currentEpoch = arena?.currentEpoch ?? null
  const epochEnd = arena?.epochEnd ?? null
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [entries, setEntries] = useState<Entry[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyPage, setHistoryPage] = useState(1)
  const [leaderboardRefresh, setLeaderboardRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const epoch = currentEpoch?.toString() ?? null
  const previousEpoch = currentEpoch && currentEpoch > BigInt(1) ? currentEpoch - BigInt(1) : null
  // V5 `epochResults` devolvia [prizePool, closed]. V6 lo sustituye por `getEpochResult`, que
  // devuelve nueve salidas: [winners, bps, winnerCount, prizePool, paidOut, totalPaid, closed,
  // voided, swept]. Portar los indices de V5 tal cual habria seguido compilando y habria leido
  // `winners` (una tupla de direcciones) como si fuera el booleano `closed`.
  //
  // `closed` SI esta en la lista de abitype y por eso `?.closed` compila; `prizePool` NO esta y
  // habria que escribir `result?.prizePool` con un error de typecheck. Se desestructura por
  // posicion para que las dos mitades se comporten igual.
  const { data: rawCurrentResult, refetch: refetchCurrentResult, isLoading: currentResultLoading } = useReadContract({ address: arcadeVaultV6Address, abi: arcadeVaultV6Abi, functionName: 'getEpochResult', args: [ARENA.id, currentEpoch ?? BigInt(0)], query: { enabled: Boolean(arcadeVaultV6Address && currentEpoch) } })
  const { data: rawPreviousResult, refetch: refetchPreviousResult, isLoading: previousResultLoading } = useReadContract({ address: arcadeVaultV6Address, abi: arcadeVaultV6Abi, functionName: 'getEpochResult', args: [ARENA.id, previousEpoch ?? BigInt(0)], query: { enabled: Boolean(arcadeVaultV6Address && previousEpoch) } })
  const currentResult = useMemo(() => {
    if (!rawCurrentResult) return undefined
    const [, , , prizePool, , , closed] = rawCurrentResult
    return { prizePool, closed }
  }, [rawCurrentResult])
  const previousResult = useMemo(() => {
    if (!rawPreviousResult) return undefined
    const [, , , prizePool, , , closed] = rawPreviousResult
    return { prizePool, closed }
  }, [rawPreviousResult])
  const closedEpoch = currentResult?.closed ? currentEpoch : previousResult?.closed ? previousEpoch : null
  const result = currentResult?.closed ? currentResult : previousResult
  const refetchResult = async () => { await Promise.all([refetchCurrentResult(), refetchPreviousResult()]) }
  const resultLoading = currentResultLoading || previousResultLoading
  const epochClosed = Boolean(closedEpoch && result?.closed === true)
  const distributionEpoch = closedEpoch ?? currentEpoch ?? BigInt(0)
  const { data: vyrDistribution } = useReadContract({ address: VYNAR_REWARDS_V3_ADDRESS, abi: vynarRewardsV3Abi, functionName: 'getEpochInfo', args: [ARENA.id, distributionEpoch], chainId: VYNAR_CHAIN_ID, query: { enabled: Boolean(VYNAR_REWARDS_V3_ADDRESS && distributionEpoch > BigInt(0)) } })
  const podium0 = useReadContract({ address: arcadeVaultV6Address, abi: arcadeVaultV6Abi, functionName: 'leaderboard', args: [ARENA.id, closedEpoch ?? BigInt(0), BigInt(0)], query: { enabled: Boolean(arcadeVaultV6Address && closedEpoch && epochClosed) } })
  const podium1 = useReadContract({ address: arcadeVaultV6Address, abi: arcadeVaultV6Abi, functionName: 'leaderboard', args: [ARENA.id, closedEpoch ?? BigInt(0), BigInt(1)], query: { enabled: Boolean(arcadeVaultV6Address && closedEpoch && epochClosed) } })
  const podium2 = useReadContract({ address: arcadeVaultV6Address, abi: arcadeVaultV6Abi, functionName: 'leaderboard', args: [ARENA.id, closedEpoch ?? BigInt(0), BigInt(2)], query: { enabled: Boolean(arcadeVaultV6Address && closedEpoch && epochClosed) } })
  const winners = [podium0.data?.[0], podium1.data?.[0], podium2.data?.[0]].filter((winner): winner is `0x${string}` => Boolean(winner))
  const winnerIndex = address ? winners.findIndex((winner) => winner.toLowerCase() === address.toLowerCase()) : -1
  const winnerAddress = winnerIndex >= 0 ? winners[winnerIndex] : undefined
  const { data: alreadyClaimed, refetch: refetchClaimed, isLoading: claimedLoading } = useReadContract({ address: arcadeVaultV6Address, abi: arcadeVaultV6Abi, functionName: 'claimed', args: [ARENA.id, closedEpoch ?? BigInt(0), winnerAddress ?? '0x0000000000000000000000000000000000000000'], query: { enabled: Boolean(arcadeVaultV6Address && closedEpoch && winnerAddress) } })
  const onChainPrizeLoading = Boolean(closedEpoch && (resultLoading || podium0.isLoading || podium1.isLoading || podium2.isLoading || (Boolean(winnerAddress) && claimedLoading)))
  const pendingPrize = Boolean(!onChainPrizeLoading && (pendingClaims.length > 0 || (epochClosed && winnerAddress && alreadyClaimed === false)))
  const visibleClaims = pendingClaims.length > 0 ? pendingClaims : (epochClosed && winnerAddress && alreadyClaimed === false ? [{ epoch: closedEpoch as bigint, prizePool: result?.prizePool ?? BigInt(0), winner: winnerAddress }] : [])
  const visibleClaim = visibleClaims.find((claim) => claim.epoch === selectedClaimEpoch) ?? visibleClaims[0] ?? null
  void visibleClaim
  const remaining = useMemo(() => epochEnd === null ? null : Math.max(0, Number(epochEnd) - now), [epochEnd, now])

  useEffect(() => { const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => window.clearInterval(timer) }, [])
  useEffect(() => { if (!epoch) return; let cancelled = false; setLoading(true); fetch(`/api/leaderboard?arena=human&epoch=${epoch}&limit=100&offset=0`).then((response) => { if (!response.ok) throw new Error('leaderboard'); return response.json() as Promise<{ entries: Entry[] }> }).then((data) => { if (!cancelled) { setEntries(data.entries); setError(false) } }).catch(() => { if (!cancelled) setError(true) }).finally(() => { if (!cancelled) setLoading(false) }); return () => { cancelled = true } }, [epoch, leaderboardRefresh])
  useEffect(() => {
    if (!epoch) return
    const refreshSeconds = Number(process.env.NEXT_PUBLIC_LEADERBOARD_REFRESH_SECONDS ?? (process.env.NEXT_PUBLIC_APP_ENV === 'production' ? 3600 : 15))
    const timer = window.setInterval(() => setLeaderboardRefresh((value) => value + 1), refreshSeconds * 1000)
    return () => window.clearInterval(timer)
  }, [epoch])
  useEffect(() => {
    // AUDIT FIX: /api/history now requires a signature-verified session for the same wallet
    // (lib/wallet-auth.ts), so fetching before sign-in would only ever 401. Without the guard the
    // catch handler silently produced an empty list, which read as "you have no games".
    if (!address || !isSignedIn) { setHistory([]); setHistoryLoading(false); return }
    let cancelled = false
    setHistoryLoading(true)
    fetch(`/api/history?wallet=${address}`, { cache: 'no-store' }).then((response) => { if (!response.ok) throw new Error('history'); return response.json() as Promise<{ entries: HistoryEntry[] }> }).then((data) => { if (!cancelled) setHistory(data.entries); setHistoryPage(1) }).catch(() => { if (!cancelled) setHistory([]) }).finally(() => { if (!cancelled) setHistoryLoading(false) })
    return () => { cancelled = true }
  }, [address, claimConfirmed, isSignedIn])
  useEffect(() => {
    if (claimConfirmed) {
      void refetchArena()
      void refetchResult()
      void refetchClaimed()
    }
  }, [claimConfirmed, refetchArena, refetchResult, refetchClaimed])

  useEffect(() => {
    setClaimError(null)
    setClaimStage('idle')
  }, [address, chainId, epoch])

  useEffect(() => {
    const refreshOnForeground = () => {
      if (document.visibilityState !== 'visible') return
      void refetchArena()
      void refetchResult()
      if (winnerAddress) void refetchClaimed()
    }
    window.addEventListener('focus', refreshOnForeground)
    document.addEventListener('visibilitychange', refreshOnForeground)
    return () => {
      window.removeEventListener('focus', refreshOnForeground)
      document.removeEventListener('visibilitychange', refreshOnForeground)
    }
  }, [refetchArena, refetchResult, refetchClaimed, winnerAddress])

  async function claim(claimEpochOverride?: bigint) {
    const claimEpoch = claimEpochOverride ?? selectedClaimEpoch ?? pendingClaims[0]?.epoch
    if (!claimEpoch || !arcadeVaultV6Address || !address) return
    if (!visibleClaims.some((claim) => claim.epoch === claimEpoch)) return
    setSelectedClaimEpoch(claimEpoch)
    setClaimError(null)
    try {
      if (chainId !== SVP_CHAIN_ID) await switchChainAsync({ chainId: SVP_CHAIN_ID })
      setClaimStage('simulating')
      const { request } = await simulateContract(config, { chainId: SVP_CHAIN_ID, address: arcadeVaultV6Address, abi: arcadeVaultV6Abi, functionName: 'claimPrize', args: [ARENA.id, claimEpoch], account: address })
      setClaimStage('wallet')
      const hash = await writeContractAsync({ ...request, chainId: SVP_CHAIN_ID })
      setClaimStage('claiming')
      await waitForTransactionReceipt(config, { chainId: SVP_CHAIN_ID, hash })
      setClaimStage('idle')
      await refetchClaimed()
    } catch (error) {
      setClaimStage('idle')
      setClaimError(getWeb3ErrorMessage(error))
    }
  }

  const prizePanel = !isConnected ? <div className="mt-8 border border-[#2a2e3a] bg-[#141922] p-5 font-jetbrains-mono text-xs text-[#8890A0]">Connect your wallet to check your prizes.</div> : onChainPrizeLoading ? <div className="mt-8 border border-[#2a2e3a] bg-[#141922] p-5 font-jetbrains-mono text-xs text-[#8890A0]">Loading podium and prize status…</div> : claimError ? <div className="mt-8 border border-[#F05A67] bg-[#141922] p-5 font-jetbrains-mono text-xs text-[#F05A67]">{claimError}</div> : pendingPrize ? <div className="mt-8 space-y-3">{visibleClaims.map((claimItem) => <div key={claimItem.epoch.toString()} className="flex items-center justify-between gap-4 border border-[#F5B935] bg-[#141922] p-5"><div><p className="font-jetbrains-mono text-xs text-[#F5B935]">PRIZE AVAILABLE</p><p className="mt-2 font-space-grotesk text-xl">Epoch {claimItem.epoch.toString()}</p><p className="mt-1 font-jetbrains-mono text-xs text-[#8890A0]">Winner: {claimItem.winner.slice(0, 6)}… · Prize {formatUnits(claimItem.prizePool, 18)} SVP</p></div><button type="button" aria-label={`Claim prize for epoch ${claimItem.epoch.toString()}`} onClick={() => { window.location.href = '/incentive' }} disabled={claimPending || claimStage !== 'idle'} className="bg-[#F5B935] px-4 py-3 font-jetbrains-mono text-xs font-bold text-[#0B0E14] disabled:opacity-50">{selectedClaimEpoch === claimItem.epoch && (claimStage === 'simulating' ? 'SIMULATING…' : claimStage === 'wallet' ? 'CONFIRM IN WALLET' : claimStage === 'claiming' || claimPending ? 'CLAIMING…' : 'CLAIM PRIZE')}</button></div>)}</div> : null

  const topEntries = entries.slice(0, 10)
  const vyrPool = vyrDistribution?.[0] ?? BigInt(0)
  const liveVynarPool = vyrPool
  const totalPoints = entries.reduce((total, entry) => total + BigInt(Math.max(0, Number(entry.score))), BigInt(0))
  const connectedEntryIndex = address ? entries.findIndex((entry) => entry.wallet.toLowerCase() === address.toLowerCase()) : -1
  const connectedEntry = connectedEntryIndex >= 0 ? entries[connectedEntryIndex] : null
  const svpPool = result?.prizePool ?? BigInt(0)

  const historyPanel = isConnected ? <section className="mt-10 border border-[#2a2e3a] bg-[#141922] p-5"><div className="flex items-center justify-between"><div><p className="font-jetbrains-mono text-xs text-[#35D0C0]">MY HISTORY</p><p className="mt-2 font-space-grotesk text-xl">Recorded games</p></div><span className="font-jetbrains-mono text-[10px] text-[#8890A0]">RECORDED SCORES</span></div>{historyLoading ? <p className="mt-6 font-jetbrains-mono text-xs text-[#8890A0]">LOADING HISTORY…</p> : history.length === 0 ? <p className="mt-6 font-jetbrains-mono text-xs text-[#8890A0]">NO GAMES YET.</p> : <div className="mt-5 divide-y divide-[#2a2e3a]">{history.slice((historyPage - 1) * 5, historyPage * 5).map((item) => <div key={`${item.epoch}-${item.created_at}`} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-space-grotesk text-lg">Epoch #{item.epoch}</p><p className="font-jetbrains-mono text-xs text-[#8890A0]">Score: {item.score.toLocaleString()}</p></div>{item.tx_hash ? <a href={`${SVP_EXPLORER_URL}/tx/${item.tx_hash}`} target="_blank" rel="noreferrer" className="font-jetbrains-mono text-xs text-[#F5B935] hover:underline">VIEW ON CHAIN</a> : <span className="font-jetbrains-mono text-xs text-[#8890A0]">SCORE CONFIRMED</span>}</div>)}</div>}{history.length > 5 && <div className="mt-5 flex items-center justify-between border-t border-[#2a2e3a] pt-4"><button type="button" onClick={() => setHistoryPage((page) => Math.max(1, page - 1))} disabled={historyPage === 1} className="font-jetbrains-mono text-xs text-[#F5B935] disabled:opacity-40">PREVIOUS</button><span className="font-jetbrains-mono text-xs text-[#8890A0]">PAGE {historyPage} / {Math.ceil(history.length / 5)}</span><button type="button" onClick={() => setHistoryPage((page) => Math.min(Math.ceil(history.length / 5), page + 1))} disabled={historyPage >= Math.ceil(history.length / 5)} className="font-jetbrains-mono text-xs text-[#F5B935] disabled:opacity-40">NEXT</button></div>}</section> : null

  // AUDIT FIX: prizePanel and historyPanel were both fully constructed and then discarded with
  // `void`, so the prize-status and my-history sections never rendered even though all the data
  // was fetched and the claim() handler was wired up. They are rendered at the end of the tree below.

  return <><a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-[#F5B935] focus:px-4 focus:py-2 focus:text-[#0B0E14]">Skip to main content</a><main id="main-content" className="min-h-screen bg-[#0B0E14] px-6 py-8 text-[#ECEEF2] lg:px-10"><div className="mx-auto max-w-5xl"><div aria-live="polite" className="sr-only">{loading ? 'Loading leaderboard.' : error ? 'Leaderboard unavailable.' : remaining === null ? 'Loading epoch.' : remaining === 0 ? 'Epoch closed.' : remaining < ARCADE_ENTRY_CUTOFF_SECONDS ? 'Entries closed.' : 'Epoch open.'}</div><Link href="/" className="inline-flex items-center gap-2 font-jetbrains-mono text-xs text-[#8890A0] hover:text-[#F5B935]"><ArrowLeft className="size-4" /> back to the arcade</Link><header className="mt-16 flex flex-col justify-between gap-6 border-b border-[#2a2e3a] pb-8 sm:flex-row sm:items-end"><div><p className="font-jetbrains-mono text-xs text-[#F5B935]">HUMAN ARENA / SVP CHAIN</p><div className="mb-5"><ArenaTabs basePath="/leaderboard" /></div><h1 className="mt-3 font-space-grotesk text-5xl font-semibold tracking-tight">Leaderboard</h1></div><div className="font-jetbrains-mono text-xs text-[#35D0C0]">● {remaining === null ? 'LOADING EPOCH' : remaining === 0 ? 'EPOCH CLOSED' : remaining < 30 ? 'ENTRIES CLOSED' : 'EPOCH OPEN'}</div></header><section className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><div className="border border-[#F5B935] bg-[#141922] p-5"><p className="font-jetbrains-mono text-[10px] text-[#F5B935]">VYR EPOCH POOL</p><p className="mt-2 font-space-grotesk text-3xl">{formatUnits(vyrPool, 18)} VYR</p><p className="mt-1 font-jetbrains-mono text-[10px] text-[#8890A0]">Published by Rewards contract</p></div><div className="border border-[#35D0C0] bg-[#141922] p-5"><p className="font-jetbrains-mono text-[10px] text-[#35D0C0]">SVP EPOCH POOL</p><p className="mt-2 font-space-grotesk text-3xl">{formatUnits(svpPool, 18)} SVP</p><p className="mt-1 font-jetbrains-mono text-[10px] text-[#8890A0]">Prize pool from Arcade contract</p></div><div className="border border-[#2a2e3a] bg-[#141922] p-5"><p className="font-jetbrains-mono text-[10px] text-[#8890A0]">CURRENT EPOCH</p><p className="mt-2 font-space-grotesk text-3xl">{epoch ?? '—'}</p></div><div className="border border-[#2a2e3a] bg-[#141922] p-5"><p className="font-jetbrains-mono text-[10px] text-[#8890A0]">CLOSES IN</p><p className="mt-2 font-jetbrains-mono text-2xl text-[#F5B935]">{remaining === null ? '--:--:--' : formatRemaining(remaining)}</p></div><div className="border border-[#2a2e3a] bg-[#141922] p-5"><p className="font-jetbrains-mono text-[10px] text-[#8890A0]">SVP POOL STATUS</p><p className="mt-2 font-space-grotesk text-3xl">{arena ? `${formatUnits(arena.pool, 18)} SVP` : '—'}</p></div><div className="border border-[#2a2e3a] bg-[#141922] p-5"><p className="font-jetbrains-mono text-[10px] text-[#8890A0]">VYR ALLOCATION</p><p className="mt-2 font-space-grotesk text-3xl text-[#35D0C0]">{formatUnits(liveVynarPool, 18)} VYR</p><p className="mt-1 font-jetbrains-mono text-[10px] text-[#8890A0]">{totalPoints.toString()} total points</p></div></section>{connectedEntry && connectedEntryIndex >= 10 && <div className="mt-6 border border-[#35D0C0] bg-[#141922] p-5"><p className="font-jetbrains-mono text-xs text-[#35D0C0]">YOUR POSITION</p><p className="mt-2 font-space-grotesk text-xl">#{connectedEntryIndex + 1} · {connectedEntry.score}</p><p className="mt-1 font-jetbrains-mono text-xs text-[#8890A0]">{connectedEntry.wallet.slice(0, 8)}…{connectedEntry.wallet.slice(-6)}</p></div>}<section className="mt-10"><div className="mb-4 flex items-end justify-between"><div><p className="font-jetbrains-mono text-xs text-[#35D0C0]">RANKING LIVE · HUMAN · EPOCH {epoch ?? '—'}</p><p className="mt-2 font-jetbrains-mono text-xs text-[#8890A0]">{remaining === 0 ? 'Closing podium…' : 'Top scores from unique players'}</p></div><button onClick={() => setLeaderboardRefresh((value) => value + 1)} className="font-jetbrains-mono text-[10px] text-[#8890A0] hover:text-[#F5B935]">refresh</button></div><div className="overflow-hidden border border-[#2a2e3a] bg-[#141922]"><div className="grid grid-cols-[56px_1fr_100px] gap-4 border-b border-[#2a2e3a] px-5 py-4 font-jetbrains-mono text-[10px] text-[#8890A0]"><span>#</span><span>PLAYER</span><span>SCORE</span></div>{loading ? <div className="px-5 py-12 font-jetbrains-mono text-sm text-[#8890A0]">Leyendo resultados...</div> : error ? <div className="px-5 py-12 font-jetbrains-mono text-sm text-[#ff8a8a]">Unable to load on-chain data.</div> : entries.length === 0 ? <div className="px-5 py-12 font-jetbrains-mono text-sm text-[#8890A0]">No games yet.</div> : topEntries.map((entry, index) => <div key={`${entry.wallet}-${entry.tx_hash ?? index}`} className="grid grid-cols-[56px_1fr_100px] items-center gap-4 border-b border-[#2a2e3a] px-5 py-6 font-jetbrains-mono text-xs last:border-0"><span className="text-[#F5B935]">{String(index + 1).padStart(2, '0')}</span><span>{entry.wallet.slice(0, 6)}…{entry.wallet.slice(-4)}</span><span className="text-[#35D0C0]">{entry.score}</span></div>)}</div></section><section className="mt-10 border border-[#2a2e3a] bg-[#141922] p-6"><p className="font-jetbrains-mono text-xs text-[#F5B935]">LAST PODIUM</p>{!closedEpoch ? <p className="mt-4 font-jetbrains-mono text-sm text-[#8890A0]">Aún no hay una época cerrada.</p> : <><p className="mt-2 font-space-grotesk text-2xl">Epoch {closedEpoch.toString()}</p>{onChainPrizeLoading ? <p className="mt-4 font-jetbrains-mono text-sm text-[#8890A0]">CARGANDO ESTADO DEL PREMIO…</p> : pendingPrize ? <button type="button" disabled={claimPending || claimStage !== 'idle'} onClick={() => void claim()} className="mt-5 inline-flex items-center gap-2 bg-[#F5B935] px-5 py-3 font-space-grotesk font-semibold text-[#0B0E14]">{(claimPending || claimStage !== 'idle') && <Loader2 className="size-4 animate-spin" />} {claimStage === 'simulating' ? 'SIMULATING…' : claimStage === 'wallet' ? 'CONFIRM IN WALLET' : claimStage === 'claiming' || claimPending ? 'CLAIMING…' : 'CLAIM PRIZE'}</button> : isConnected && result?.prizePool && Boolean(winnerAddress) ? <p className="mt-4 font-jetbrains-mono text-sm text-[#35D0C0]">PREMIO RECLAMADO</p> : <p className="mt-4 font-jetbrains-mono text-sm text-[#8890A0]">{isConnected ? 'NO PRIZE PENDING' : 'CONNECT WALLET TO CHECK PRIZE STATUS'}</p>}</>}</section>{prizePanel}{historyPanel}</div></main>

  </>
  }

// `Board` lee `useSearchParams`, y App Router exige un limite de Suspense alrededor de cualquier
// componente cliente que lo haga, o la ruta no se puede prerenderizar. Fallback vacio: la pagina
// ya tiene su propio estado de carga y un esqueleto encima solo añade un parpadeo.
export default function Leaderboard() { return <WalletProvider><Suspense fallback={null}><Board /></Suspense></WalletProvider> }
