'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { formatUnits } from 'viem'
import { useAccount, useBalance, useReadContract, useSwitchChain, useWriteContract } from 'wagmi'
import { simulateContract, waitForTransactionReceipt } from 'wagmi/actions'
import { ArrowLeft } from 'lucide-react'
import { WalletProvider } from '@/components/wallet-provider'
import { ArenaTabs } from '@/components/arena-tabs'
import { getWeb3ErrorMessage } from '@/lib/play-errors'
import { arcadeVaultV6Abi, arcadeVaultV6Address } from '@/lib/arcade-vault-v6-abi'
import { arenaByType, parseArenaParam } from '@/lib/arcade-arenas'
import { SVP_CHAIN_ID, SVP_EXPLORER_URL } from '@/lib/arcade-config'
import { VYNAR_ADDRESS, VYNAR_CHAIN_ID, VYNAR_REWARDS_V3_ADDRESS, vynarAbi } from '@/lib/vynar-config'
import { vynarRewardsV3Abi } from '@/lib/vynar-rewards-v3-abi'
import { useWalletSignIn } from '@/lib/use-wallet-sign-in'
import { useConfig } from 'wagmi'

type Distribution = { epoch: string; prize_pool: string; top10: Array<{ rank: number; wallet: string; score: string }>; status: string; arena: number }

type Proof = { points?: string; amount: string; rank?: number; score?: string; claimed: boolean; claimStatus: string | null; txHash: string | null }
type RewardRow = { epoch: string; amount: string; status: string; txHash: string | null; confirmedAt: string | null }
// `arenaType` viene en cada fila: la ruta devuelve los premios de todos los modos y las etiqueta,
  // asi que el filtro de `mine()` mas abajo tiene con comparar contra `ARENA.type`.
  type EntryRow = { epoch: string; arenaType?: string | null; score: number; txHash: string | null; createdAt: string }
type SvpReward = { epoch: string; amount: string; claimed: boolean; txHash: string | null }

function formatToken(value: bigint | string, decimals = 18) {
  const numeric = Number(formatUnits(typeof value === 'string' ? BigInt(value) : value, decimals))
  return Number.isFinite(numeric) ? numeric.toFixed(3) : '0.000'
}

function IncentiveBoard() {
  // Modo de la pagina de premios. Lo que mas importa aqui es el `claimPrize`: antes iba fijado a
  // human, asi que un ganador de medium o hard lanzaba `claimPrize(0, epoch)` y el contrato no
  // encontraba su premio. El tx se ejecutaba, gas incluido, y la UI no distinguia ese fallo de
  // ningun otro porque el mensaje venia del wallet. Con el id del modo correcto deja de ser posible.
  const arenaType = parseArenaParam(useSearchParams().get('arena')) ?? 'human'
  const ARENA = arenaByType(arenaType)!
  const { address, isConnected } = useAccount()
  const config = useConfig()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const { data: svpBalance } = useBalance({ address, chainId: SVP_CHAIN_ID, query: { enabled: Boolean(address) } })
  const { data: balance, refetch: refetchBalance } = useReadContract({ address: VYNAR_ADDRESS, abi: vynarAbi, functionName: 'balanceOf', args: [address ?? '0x0000000000000000000000000000000000000000'], chainId: VYNAR_CHAIN_ID, query: { enabled: Boolean(address && VYNAR_ADDRESS), refetchOnMount: 'always', refetchOnWindowFocus: true, refetchInterval: 15_000 } })
  const [distributions, setDistributions] = useState<Distribution[]>([])
  const [proofs, setProofs] = useState<Record<string, Proof>>({})
  const [svpClaims, setSvpClaims] = useState<Array<{ epoch: bigint; prizePool: bigint }>>([])
  const [claiming, setClaiming] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [rewards, setRewards] = useState<RewardRow[]>([])
  const [svpRewards, setSvpRewards] = useState<SvpReward[]>([])
  const [entries, setEntries] = useState<EntryRow[]>([])
  const [rewardsPage, setRewardsPage] = useState(1)
  const [entriesPage, setEntriesPage] = useState(1)
  // AUDIT FIX: these endpoints now require a signature-verified session for the same wallet
  // (lib/wallet-auth.ts). Firing them before sign-in completes just produced 401s, and the
  // previous catch handlers silently blanked the tables, so the user saw "no rewards" instead of
  // "not signed in yet".
  const { isSignedIn, status: signInStatus } = useWalletSignIn()
  useEffect(() => {
    if (!address || !isSignedIn) { setRewards([]); setEntries([]); return }
    let cancelled = false
    // El modo viaja en la query. Sin el, las rutas caen a `human` y la pagina se contradiria a si
    // misma: la tabla de premios seria la de human mientras `claimPrize` y `claim` se firmarian
    // con `ARENA.id`. Un ganador de medium veria sus premios en la lista y el tx revertiria.
    fetch(`/api/incentive/rewards?wallet=${address}&arena=${arenaType}`, { cache: 'no-store' }).then((response) => response.ok ? response.json() : Promise.reject()).then((body: { rewards: RewardRow[]; entries: EntryRow[] }) => { if (!cancelled) { setRewards(body.rewards); setEntries(body.entries); setRewardsPage(1); setEntriesPage(1) } }).catch(() => { if (!cancelled) { setRewards([]); setEntries([]) } })
    return () => { cancelled = true }
  }, [address, message, isSignedIn, arenaType])

  // `/api/incentive/epochs` no acepta modo: devuelve los repartos de TODAS las arenas, y cada fila
  // trae su `arena`. Se filtra aqui. Sin este filtro se listan en la pestaña de human los premios
  // de medium, y el boton de reclamar usa `ARENA.id` (human) sobre una fila que es de medium: el
  // contrato no encuentra el premio y el error llega desde el wallet, sin relacion aparente con
  // el modo equivocado. La fila se descarta y no se muestra, que es lo unico honesto aqui.
  useEffect(() => { let cancelled = false; fetch('/api/incentive/epochs').then((response) => response.ok ? response.json() : Promise.reject()).then((body: { snapshots?: Distribution[]; distributions?: Distribution[] }) => { if (cancelled) return; const all = Array.isArray(body.snapshots) ? body.snapshots : Array.isArray(body.distributions) ? body.distributions : []; setDistributions(all.filter((row) => Number(row.arena) === ARENA.id)) }).catch(() => { if (!cancelled) setDistributions([]) }); return () => { cancelled = true } }, [ARENA.id])
  useEffect(() => {
    if (!address || !isSignedIn) { setProofs({}); setSvpRewards([]); setEntries([]); return }
    let cancelled = false
// `/api/incentive/my-rewards` devuelve los premios de TODOS los modos por diseño: el indice de
    // la ruta es por (epoch, arenaType) precisamente porque con tres arenas hay tres snapshots por
    // epoch. Es decir, el servidor YA entrego las filas desambiguadas, cada una con su `arenaType`.
    // Filtrar aqui no es una comodidad, es la parte que le toca a esta pagina: sin el, la pestaña de
    // medium lista los premios de human y el boton de reclamar firma `claimPrize` con `ARENA.id`
    // (medium) sobre una fila que es de human. El contrato no encuentra el premio y el error llega
    // desde el wallet, sin relacion aparente con el modo equivocado.
    //
    // Una fila cuyo `arenaType` es null trae un id que el registro ya no conoce. Se descarta: no se
    // puede reclamar contra un id que nadie definio, y mostrarla seria prometer un premio que no
    // se puede cobrar.
    fetch(`/api/incentive/my-rewards?wallet=${address}`, { cache: 'no-store' }).then((response) => response.ok ? response.json() : Promise.reject()).then((body: { vyr: Array<Proof & { epoch: string; arenaType: string | null }>; svp: Array<{ epoch: string; arenaType: string | null; prizePool: string; rewardAmount: string; claimStatus: string | null; txHash: string | null }>; entries: EntryRow[] }) => {
      if (cancelled) return
      const mine = <T extends { arenaType?: string | null }>(rows: T[]) => rows.filter((row) => row.arenaType === ARENA.type)
      const vyrRows = mine(Array.isArray(body.vyr) ? body.vyr : [])
      const svpRows = mine(Array.isArray(body.svp) ? body.svp : [])
      // Con el filtro de arriba el epoch vuelve a ser clave unica dentro del conjunto: los tres
      // modos ya no compiten por el mismo epoch. Antes, sin filtro, `Object.fromEntries` dejaba en
      // pantalla el premio del modo que hubiera llegado el ultimo, sin error ni aviso.
      setProofs(Object.fromEntries(vyrRows.map((row) => [row.epoch, row])))
      setSvpRewards(svpRows.map((row) => ({ epoch: row.epoch, amount: row.rewardAmount, claimed: row.claimStatus === 'confirmed', txHash: row.txHash })))
      setSvpClaims(svpRows.filter((row) => row.claimStatus !== 'confirmed').map((row) => ({ epoch: BigInt(row.epoch), prizePool: BigInt(row.rewardAmount) })))
      setEntries(mine(Array.isArray(body.entries) ? body.entries : []))
    }).catch(() => { if (!cancelled) { setProofs({}); setSvpRewards([]); setEntries([]) } })
    return () => { cancelled = true }
  }, [address, message, isSignedIn, arenaType])

  // AUDIT FIX: points and amount are deliberately NOT sent to claim-status. The server already
  // ignored them (it derives amount from getEpochInfo/getPercentages), and accepting client-supplied
  // values into a financial table was the finding. Omitting them keeps the contract honest.
  async function claimVyr(epoch: string) { if (!address || !VYNAR_REWARDS_V3_ADDRESS) { setMessage('VYR rewards are temporarily unavailable.'); return; } if (!isSignedIn) { setMessage('Sign in with this wallet first.'); return; } setClaiming(`vyr-${epoch}`); setMessage(null); try { await switchChainAsync({ chainId: VYNAR_CHAIN_ID }); const { request } = await simulateContract(config, { address: VYNAR_REWARDS_V3_ADDRESS, abi: vynarRewardsV3Abi, functionName: 'claim', chainId: VYNAR_CHAIN_ID, account: address, args: [ARENA.id, BigInt(epoch)] }); const txHash = await writeContractAsync(request); // `arena` en el body, no solo en la query: la ruta lo lee de ahi (claim-status:71) y sin el cae a
    // human. Entonces el tx on-chain seria de `ARENA.id` y la fila de `vyr_claims` quedaria con
    // `arena_type='human'`: un premio de medium archivado como de human. `my-rewards` indexa por
    // epoch y, con tres arenas, esa fila se solaparia con la verdadera y el jugador veria un estado
    // de reclamo que no es el suyo, sin ningun error en ninguna parte.
    await fetch('/api/incentive/claim-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ epoch, wallet: address, txHash, status: 'pending', arena: arenaType }) }); const receipt = await waitForTransactionReceipt(config, { chainId: VYNAR_CHAIN_ID, hash: txHash }); const status = receipt.status === 'success' ? 'confirmed' : 'failed'; await fetch('/api/incentive/claim-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ epoch, wallet: address, txHash, status, arena: arenaType }) }); setProofs((current) => ({ ...current, [epoch]: { ...current[epoch], claimStatus: status, txHash } })); setMessage(status === 'confirmed' ? `Epoch ${epoch} VYR claim confirmed.` : `Epoch ${epoch} VYR claim failed.`); await refetchBalance() } catch (error) { setMessage(getWeb3ErrorMessage(error)) } finally { setClaiming(null) } }
  async function claimSvp(epoch: bigint) { if (!address) return; setClaiming(`svp-${epoch}`); try { await switchChainAsync({ chainId: SVP_CHAIN_ID }); const { request } = await simulateContract(config, { address: arcadeVaultV6Address, abi: arcadeVaultV6Abi, functionName: 'claimPrize', args: [ARENA.id, epoch], account: address, chainId: SVP_CHAIN_ID }); const txHash = await writeContractAsync(request); const receipt = await waitForTransactionReceipt(config, { chainId: SVP_CHAIN_ID, hash: txHash }); if (receipt.status !== 'success') throw new Error('SVP claim failed'); setSvpClaims((claims) => claims.filter((claim) => claim.epoch !== epoch)); window.open(`${SVP_EXPLORER_URL}/tx/${txHash}`, '_blank', 'noopener,noreferrer') } catch (error) { setMessage(getWeb3ErrorMessage(error)) } finally { setClaiming(null) } }

  return <><a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-[#F5B935] focus:px-4 focus:py-2 focus:text-[#0B0E14]">Skip to main content</a><main id="main-content" className="min-h-screen bg-[#0B0E14] px-6 py-8 text-[#ECEEF2] lg:px-10"><div className="mx-auto max-w-5xl"><Link href="/leaderboard" className="inline-flex items-center gap-2 font-jetbrains-mono text-xs text-[#8890A0] hover:text-[#F5B935]"><ArrowLeft className="size-4" /> back to leaderboard</Link><header className="mt-16 border-b border-[#2a2e3a] pb-8"><p className="font-jetbrains-mono text-xs text-[#F5B935]">VYNAR INCENTIVES / CHAIN 2517</p><div className="mb-5"><ArenaTabs basePath="/incentive" /></div><h1 className="mt-3 font-space-grotesk text-5xl font-semibold tracking-tight">Incentive</h1><p className="mt-4 max-w-2xl font-jetbrains-mono text-xs leading-6 text-[#8890A0]">Rewards are discovered from published distributions and remain recoverable after refresh.</p></header>{isConnected && signInStatus !== 'signed_in' ? <div role="status" className="mt-8 border border-[#F5B935] bg-[#141922] p-6 font-jetbrains-mono text-xs text-[#F5B935]">{signInStatus === 'error' ? 'We could not verify this wallet. Approve the signature to view your rewards.' : 'Verifying wallet ownership. Your rewards appear once you approve the signature.'}</div> : null}{!isConnected ? <div className="mt-8 border border-[#2a2e3a] bg-[#141922] p-6 font-jetbrains-mono text-xs text-[#8890A0]">Connect your wallet to view rewards.</div> : <><section className="mt-10 grid gap-4 sm:grid-cols-2"><div className="border border-[#35D0C0] bg-[#141922] p-6"><p className="font-jetbrains-mono text-xs text-[#35D0C0]">SVP BALANCE</p><p className="mt-3 font-space-grotesk text-3xl">{svpBalance === undefined ? '—' : formatToken(svpBalance.value, svpBalance.decimals)} <span className="text-lg text-[#35D0C0]">SVP</span></p></div><div className="border border-[#35D0C0] bg-[#141922] p-6"><p className="font-jetbrains-mono text-xs text-[#35D0C0]">VYR BALANCE</p><p className="mt-3 font-space-grotesk text-3xl">{balance === undefined ? '—' : formatToken(balance, 18)} <span className="text-lg text-[#35D0C0]">VYR</span></p></div></section><section className="mt-10 border border-[#F5B935] bg-[#141922] p-6"><div className="flex items-end justify-between"><div><p className="font-jetbrains-mono text-xs text-[#F5B935]">VYR CLAIMS</p><h2 className="mt-2 font-space-grotesk text-2xl">Closed epoch rewards</h2></div><span className="font-jetbrains-mono text-[10px] text-[#8890A0]">CLAIM WHEN PUBLISHED</span></div><div className="mt-6 divide-y divide-[#2a2e3a]">{Object.entries(proofs).map(([epoch, proof]) => <div key={`claim-${epoch}`} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-space-grotesk text-lg">Epoch {epoch}</p><p className="font-jetbrains-mono text-xs text-[#8890A0]">Estimated {formatToken(proof.amount)} VYR · {proof.claimStatus ?? 'READY'}</p></div>{proof.claimStatus === 'confirmed' ? <span className="font-jetbrains-mono text-xs text-[#35D0C0]">CLAIMED</span> : <button type="button" onClick={() => void claimVyr(epoch)} disabled={claiming === `vyr-${epoch}`} className="bg-[#F5B935] px-4 py-3 font-jetbrains-mono text-xs font-bold text-[#0B0E14] disabled:opacity-50">{claiming === `vyr-${epoch}` ? 'CLAIMING…' : 'CLAIM VYR'}</button>}</div>)}{Object.keys(proofs).length === 0 && <p className="py-4 font-jetbrains-mono text-xs text-[#8890A0]">NO PUBLISHED VYR REWARDS YET.</p>}</div></section><section className="mt-10 border border-[#2a2e3a] bg-[#141922] p-6"><div className="flex items-end justify-between"><div><p className="font-jetbrains-mono text-xs text-[#35D0C0]">REWARDS</p><h2 className="mt-2 font-space-grotesk text-2xl">SVP + VYR earnings</h2></div><span className="font-jetbrains-mono text-[10px] text-[#8890A0]">5 PER PAGE</span></div><div className="mt-6 divide-y divide-[#2a2e3a]">{svpRewards.slice((rewardsPage - 1) * 5, rewardsPage * 5).map((reward) => <div key={`svp-${reward.epoch}`} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-space-grotesk text-lg">Epoch {reward.epoch} · SVP</p><p className="font-jetbrains-mono text-xs text-[#8890A0]">Earned {formatToken(reward.amount)} SVP · {reward.claimed ? 'CLAIMED' : 'CLAIMABLE'}</p></div><span className="font-jetbrains-mono text-xs text-[#8890A0]">{reward.txHash ? `TXID ${reward.txHash.slice(0, 10)}…` : reward.claimed ? 'TXID ONCHAIN' : 'TXID PENDING'}</span></div>)}{svpClaims.map((claim) => <div key={`svp-reward-${claim.epoch}`} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-space-grotesk text-lg">Epoch {claim.epoch.toString()} · SVP</p><p className="font-jetbrains-mono text-xs text-[#8890A0]">Earned {formatUnits(claim.prizePool, 18)} SVP · CLAIMABLE</p></div><button type="button" onClick={() => void claimSvp(claim.epoch)} disabled={claiming === `svp-${claim.epoch}`} className="font-jetbrains-mono text-xs text-[#F5B935] disabled:opacity-40">{claiming === `svp-${claim.epoch}` ? 'CLAIMING…' : 'CLAIM REWARD'}</button></div>)}{rewards.slice((rewardsPage - 1) * 5, rewardsPage * 5).map((reward) => <div key={`vyr-${reward.epoch}`} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-space-grotesk text-lg">Epoch {reward.epoch} · VYR</p><p className="font-jetbrains-mono text-xs text-[#8890A0]">Earned {formatUnits(BigInt(reward.amount), 18)} VYR · {reward.status.toUpperCase()}</p></div>{reward.txHash ? <a href={`${SVP_EXPLORER_URL}/tx/${reward.txHash}`} target="_blank" rel="noreferrer" className="font-jetbrains-mono text-xs text-[#F5B935] hover:underline">TXID {reward.txHash.slice(0, 10)}…</a> : <span className="font-jetbrains-mono text-xs text-[#8890A0]">TXID PENDING</span>}</div>)}{rewards.length === 0 && <p className="py-4 font-jetbrains-mono text-xs text-[#8890A0]">NO VYR REWARDS YET.</p>}</div>{rewards.length > 5 && <div className="mt-5 flex items-center justify-between border-t border-[#2a2e3a] pt-4"><button type="button" onClick={() => setRewardsPage((page) => Math.max(1, page - 1))} disabled={rewardsPage === 1} className="font-jetbrains-mono text-xs text-[#F5B935] disabled:opacity-40">PREVIOUS</button><span className="font-jetbrains-mono text-xs text-[#8890A0]">PAGE {rewardsPage} / {Math.ceil(rewards.length / 5)}</span><button type="button" onClick={() => setRewardsPage((page) => Math.min(Math.ceil(rewards.length / 5), page + 1))} disabled={rewardsPage >= Math.ceil(rewards.length / 5)} className="font-jetbrains-mono text-xs text-[#F5B935] disabled:opacity-40">NEXT</button></div>}</section><section className="mt-10 border border-[#2a2e3a] bg-[#141922] p-6"><div className="flex items-end justify-between"><div><p className="font-jetbrains-mono text-xs text-[#35D0C0]">ENTRIES</p><h2 className="mt-2 font-space-grotesk text-2xl">Entry history</h2></div><span className="font-jetbrains-mono text-[10px] text-[#8890A0]">5 PER PAGE</span></div><div className="mt-6 divide-y divide-[#2a2e3a]">{entries.slice((entriesPage - 1) * 5, entriesPage * 5).map((entry) => <div key={`${entry.epoch}-${entry.createdAt}`} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-space-grotesk text-lg">Epoch {entry.epoch}</p><p className="font-jetbrains-mono text-xs text-[#8890A0]">Score {entry.score.toLocaleString()}</p></div>{entry.txHash ? <a href={`${SVP_EXPLORER_URL}/tx/${entry.txHash}`} target="_blank" rel="noreferrer" className="font-jetbrains-mono text-xs text-[#F5B935] hover:underline">ENTRY TXID {entry.txHash.slice(0, 10)}…</a> : <span className="font-jetbrains-mono text-xs text-[#8890A0]">ENTRY CONFIRMED</span>}</div>)}{entries.length === 0 && <p className="py-4 font-jetbrains-mono text-xs text-[#8890A0]">NO ENTRIES YET.</p>}</div>{entries.length > 5 && <div className="mt-5 flex items-center justify-between border-t border-[#2a2e3a] pt-4"><button type="button" onClick={() => setEntriesPage((page) => Math.max(1, page - 1))} disabled={entriesPage === 1} className="font-jetbrains-mono text-xs text-[#F5B935] disabled:opacity-40">PREVIOUS</button><span className="font-jetbrains-mono text-xs text-[#8890A0]">PAGE {entriesPage} / {Math.ceil(entries.length / 5)}</span><button type="button" onClick={() => setEntriesPage((page) => Math.min(Math.ceil(entries.length / 5), page + 1))} disabled={entriesPage >= Math.ceil(entries.length / 5)} className="font-jetbrains-mono text-xs text-[#F5B935] disabled:opacity-40">NEXT</button></div>}</section><section className="hidden mt-10 border border-[#35D0C0] bg-[#141922] p-6"><p className="font-jetbrains-mono text-xs text-[#35D0C0]">CURRENT VYR BALANCE</p><p className="mt-3 font-space-grotesk text-4xl">{balance === undefined ? '—' : formatToken(balance, 18)} <span className="text-xl text-[#35D0C0]">VYR</span></p></section><section className="hidden mt-10 border border-[#2a2e3a] bg-[#141922] p-6"><div className="flex items-end justify-between"><div><p className="font-jetbrains-mono text-xs text-[#35D0C0]">REWARDS HISTORY</p><h2 className="mt-2 font-space-grotesk text-2xl">Epoch transactions</h2></div><span className="font-jetbrains-mono text-[10px] text-[#8890A0]">SVP + VYR</span></div><div className="mt-6 divide-y divide-[#2a2e3a]">{svpRewards.slice((rewardsPage - 1) * 5, rewardsPage * 5).map((reward) => <div key={`svp-${reward.epoch}`} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-space-grotesk text-lg">Epoch {reward.epoch} · SVP</p><p className="font-jetbrains-mono text-xs text-[#8890A0]">Earned {formatToken(reward.amount)} SVP · {reward.claimed ? 'CLAIMED' : 'CLAIMABLE'}</p></div><span className="font-jetbrains-mono text-xs text-[#8890A0]">{reward.txHash ? `TXID ${reward.txHash.slice(0, 10)}…` : reward.claimed ? 'TXID ONCHAIN' : 'TXID PENDING'}</span></div>)}{svpClaims.map((claim) => <div key={`svp-${claim.epoch}`} className="flex items-center justify-between gap-4 py-4"><div><p className="font-space-grotesk text-lg">Epoch {claim.epoch.toString()} · SVP</p><p className="font-jetbrains-mono text-xs text-[#8890A0]">Prize {formatUnits(claim.prizePool, 18)} SVP</p></div><button type="button" onClick={() => void claimSvp(claim.epoch)} disabled={claiming === `svp-${claim.epoch}`} className="bg-[#F5B935] px-4 py-3 font-jetbrains-mono text-xs font-bold text-[#0B0E14]">CLAIM SVP</button></div>)}{Object.entries(proofs).map(([proofEpoch, proof]) => { const distribution = distributions.find((item) => item.epoch === proofEpoch) ?? { epoch: proofEpoch, prize_pool: proof.amount, top10: [], status: 'confirmed', arena: ARENA.id }; return <div key={`vyr-${distribution.epoch}`} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-space-grotesk text-lg">Epoch {distribution.epoch} · VYR</p><p className="font-jetbrains-mono text-xs text-[#8890A0]">Allocation {formatUnits(BigInt(proof?.amount ?? distribution.prize_pool), 18)} VYR · {distribution.top10.length} winners · arena {distribution.arena}</p>{proof?.txHash && <a className="font-jetbrains-mono text-xs text-[#35D0C0]" href={`https://explorer.svpchain.com/tx/${proof.txHash}`} target="_blank" rel="noreferrer">{proof.claimStatus === 'confirmed' ? 'CLAIMED · ' : 'CLAIM PENDING · '}{proof.txHash.slice(0, 12)}…</a>}</div><button type="button" onClick={() => void claimVyr(distribution.epoch)} disabled={!proof || proof.claimStatus === 'confirmed' || claiming === `vyr-${distribution.epoch}`} className="border border-[#35D0C0] px-4 py-3 font-jetbrains-mono text-xs font-bold text-[#35D0C0] disabled:opacity-50">{proof?.claimStatus === 'confirmed' ? 'CLAIMED VYR' : proof?.claimStatus === 'pending' ? 'CLAIM PENDING' : proof ? 'CLAIM VYR' : 'NO ALLOCATION'}</button></div>})}</div>{message && <p className="mt-5 font-jetbrains-mono text-xs text-[#F5B935]">{message}</p>}</section></>}</div></main></>
}
// Suspense por el mismo motivo que en /leaderboard: `useSearchParams` en un componente cliente lo
// exige para que la ruta sea prerenderizable.
export default function IncentivePage() { return <WalletProvider><Suspense fallback={null}><IncentiveBoard /></Suspense></WalletProvider> }
