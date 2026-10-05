'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowUpRight, Bot, CircleDollarSign, Gamepad2, Trophy, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useReadContract } from 'wagmi'
import { arcadeVaultV6Abi, arcadeVaultV6Address } from '@/lib/arcade-vault-v6-abi'
import { ArenaTabs } from '@/components/arena-tabs'
import { arenaByType, parseArenaParam } from '@/lib/arcade-arenas'
import { VYNAR_REWARDS_V3_ADDRESS, VYNAR_CHAIN_ID } from '@/lib/vynar-config'
import { vynarRewardsV3Abi } from '@/lib/vynar-rewards-v3-abi'

const lines = [
  { t: 'req', text: 'GET /play HTTP/1.1', c: 'text-[#ECEEF2]' },
  { t: 'muted', text: 'Host: arcade.svpchain.com', c: 'text-[#8890A0]' },
  { t: 'muted', text: 'X-Agent: human | wallet: 0x8b…4f21', c: 'text-[#8890A0]' },
  { t: '402', text: 'HTTP/1.1 402 Payment Required', c: 'text-[#F5B935]' },
  { t: 'muted', text: 'X-PAYMENT: required', c: 'text-[#8890A0]' },
  { t: 'pay', text: 'amount: 0.1 SVP  →  0xArcade…Vault', c: 'text-[#F5B935]' },
  { t: 'sign', text: 'signing transaction… 0x9a7c…e12d', c: 'text-[#35D0C0]' },
  { t: 'ok', text: 'HTTP/1.1 200 OK', c: 'text-[#35D0C0]' },
  { t: 'muted', text: 'session: 0xplay_7f2a  |  ready: true', c: 'text-[#8890A0]' },
]

function TerminalSequence() {
  const [visible, setVisible] = useState(0)
  const prefersReducedMotion = useReducedMotion()
  useEffect(() => {
    if (visible >= lines.length) return
    const timer = setTimeout(() => setVisible((value) => value + 1), visible === 0 ? 600 : 360)
    return () => clearTimeout(timer)
  }, [visible])
  return (
    <div className="overflow-hidden rounded-sm border border-[#2a2e3a] bg-[#090b10] shadow-2xl shadow-black/40">
      <div className="flex items-center justify-between border-b border-[#2a2e3a] bg-[#141922] px-5 py-3 font-jetbrains-mono text-[11px] text-[#8890A0]">
        <span className="flex items-center gap-2"><span className="size-2 rounded-full bg-[#F5B935]" /> SVP_ARCADE / PLAY_API</span>
        <span>LIVE · 2517</span>
      </div>
      <div className="min-h-[330px] p-5 sm:p-8">
        <div className="mb-6 font-jetbrains-mono text-xs text-[#8890A0]">// pay-per-play protocol trace</div>
        {lines.slice(0, visible).map((line, index) => (
          <motion.div key={line.text} initial={prefersReducedMotion ? false : { opacity: 0, x: -8 }} animate={prefersReducedMotion ? undefined : { opacity: 1, x: 0 }} className={`terminal-text ${line.c}`}>
            <span className="mr-4 inline-block w-5 text-right text-[#3a4150]">{String(index + 1).padStart(2, '0')}</span>{line.text}
          </motion.div>
        ))}
        {visible < lines.length && <span className="ml-9 inline-block h-4 w-2 animate-pulse bg-[#F5B935]" />}
      </div>
      <div className="flex items-center justify-between border-t border-[#2a2e3a] px-5 py-3 font-jetbrains-mono text-[10px] text-[#8890A0]"><span>RPC: svp-dataseed1-testnet</span><span className="text-[#35D0C0]">● CONNECTED</span></div>
    </div>
  )
}

export function ArcadeHome() {
// Modo mostrado en la portada. El epoch y los dos pools de arriba son los de ESTE modo, no los de
  // human: cada arena tiene epoch y saldos propios, asi que mostrar los de human mientras se
  // anuncia otro modo es un numero falso en la pantalla mas vista de la app.
  const arenaType = parseArenaParam(useSearchParams().get('arena')) ?? 'human'
  const ARENA = arenaByType(arenaType)!
const { data: rawArena } = useReadContract({ address: arcadeVaultV6Address, abi: arcadeVaultV6Abi, functionName: 'getArenaInfo', args: [ARENA.id], chainId: 2517, query: { refetchInterval: 30_000, staleTime: 15_000, retry: 1 } })
  // Se desestructura por posicion con nombres locales. Los indices 3 y 6 son correctos para V6, pero
  // un numero suelto no dice que campo es: si el contrato inserta una salida en medio, `info?.[6]`
  // pasa a devolver `active` (un bool) donde se esperaba el pool y el typecheck no dice nada. La
  // razon de la regla esta en lib/server-blockchain.ts, sobre readArena().
  // getArenaInfo: [entryFee, protocolFeeBps, epochDuration, currentEpoch, epochStart, epochEnd, pool, active, paused, secondsLeft]
  const arena = useMemo(() => (rawArena ? { currentEpoch: rawArena[3], pool: rawArena[6] } : undefined), [rawArena])
  const currentEpoch = arena?.currentEpoch
  const { data: rewardInfo } = useReadContract({ address: VYNAR_REWARDS_V3_ADDRESS, abi: vynarRewardsV3Abi, functionName: 'getEpochInfo', args: [ARENA.id, currentEpoch ?? BigInt(0)], chainId: VYNAR_CHAIN_ID, query: { enabled: Boolean(VYNAR_REWARDS_V3_ADDRESS && currentEpoch), refetchInterval: 30_000, staleTime: 15_000, retry: 1 } })
  const epochLabel = currentEpoch === undefined ? 'EPOCH ---' : `EPOCH ${Number(currentEpoch).toString().padStart(3, '0')}`
  // getEpochInfo: [pool, positionCount, winners, totalClaimed, settledAt, funded, settled, canceled]
  const vynarPool = rewardInfo?.[0]
  const svpPool = arena?.pool

  return (
    <>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-[#F5B935] focus:px-4 focus:py-2 focus:text-[#0B0E14]">Skip to main content</a>
      <main id="main-content" className="min-h-screen bg-[#0B0E14]" data-vynar-pool={vynarPool?.toString()} data-svp-pool={svpPool?.toString()}>
      <nav className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-5 sm:px-6 lg:px-10 lg:py-6">
        <Link href="/" className="flex shrink-0 items-center gap-2 font-space-grotesk text-base font-bold tracking-tight sm:gap-3 sm:text-lg"><span className="grid size-8 place-items-center bg-[#F5B935] text-[#0B0E14]">S</span> SVP <span className="text-[#F5B935]">ARCADE</span></Link>
        <div className="flex shrink-0 items-center gap-3 font-jetbrains-mono text-[10px] text-[#8890A0] sm:gap-6 sm:text-xs"><Link href="/leaderboard" className="transition-colors hover:text-[#F5B935]">leaderboard</Link><Link href={`/play?arena=${arenaType}`} className="border border-[#F5B935] px-3 py-2 text-[#F5B935] transition-colors hover:bg-[#F5B935] hover:text-[#0B0E14] sm:px-4">Pay & Play</Link></div>
      </nav>

      <section className="mx-auto grid max-w-7xl gap-12 px-6 pb-24 pt-12 lg:grid-cols-[0.72fr_1.28fr] lg:items-center lg:px-10 lg:pt-20">
        <div><div className="mb-7 flex items-center gap-3 font-jetbrains-mono text-xs text-[#35D0C0]"><span className="h-px w-8 bg-[#35D0C0]" /> SVP CHAIN · {epochLabel}</div><div className="mb-6"><ArenaTabs basePath="/" /></div><h1 className="font-space-grotesk text-5xl font-semibold leading-[0.95] tracking-[-0.04em] text-[#ECEEF2] sm:text-7xl">Insert<br /><span className="text-[#F5B935]">coin.</span><br />Make history.</h1><p className="mt-7 max-w-md text-lg leading-relaxed text-[#8890A0]">An on-chain arcade where every game starts with a <span className="font-jetbrains-mono text-[#ECEEF2]">402 Payment Required</span>. Humans and agents compete on the same scoreboard.</p><div className="mt-9 flex flex-wrap items-center gap-5"><Link href="/play" className="group inline-flex items-center gap-3 bg-[#F5B935] px-6 py-3 font-space-grotesk font-bold text-[#0B0E14] transition-transform hover:-translate-y-0.5"><CircleDollarSign className="size-5 transition-transform group-hover:rotate-12" /> Pay & Play</Link><Link href="/leaderboard" className="font-jetbrains-mono text-xs text-[#8890A0] underline decoration-[#35D0C0] underline-offset-4 hover:text-[#35D0C0]">View scoreboard</Link></div></div>
        <div className="relative"><div className="absolute -inset-5 -z-10 bg-[#F5B935]/5 blur-3xl" /><TerminalSequence /></div>
      </section>

      <section className="border-y border-[#2a2e3a] bg-[#11151d]" id="como-funciona"><div className="mx-auto max-w-7xl px-6 py-20 lg:px-10"><div className="mb-12 flex items-end justify-between gap-6"><div><p className="font-jetbrains-mono text-xs text-[#F5B935]">THE RITUAL</p><h2 className="mt-3 font-space-grotesk text-4xl font-semibold tracking-tight">Four moves.<br />One valid game.</h2></div><p className="hidden max-w-xs text-sm leading-relaxed text-[#8890A0] md:block">x402 turns game access into a protocol primitive, not a user account.</p></div><div className="grid gap-px bg-[#2a2e3a] md:grid-cols-4">{[{n:'01',icon:CircleDollarSign,title:'Insert coin',text:'Open the cabinet and prepare your SVP wallet.'},{n:'02',icon:Zap,title:'Pay',text:'Sign 0.1 SVP when the server responds with 402.'},{n:'03',icon:Gamepad2,title:'Play',text:'React, score points, and beat your best.'},{n:'04',icon:Trophy,title:'Claim prize',text:'The top score of the epoch takes the prize pool.'}].map(({n,icon:Icon,title,text})=><div key={n} className="bg-[#141922] p-7"><div className="mb-10 flex items-center justify-between"><span className="font-jetbrains-mono text-xs text-[#F5B935]">{n}</span><Icon className="size-5 text-[#8890A0]" /></div><h3 className="font-space-grotesk text-xl font-semibold">{title}</h3><p className="mt-3 text-sm leading-relaxed text-[#8890A0]">{text}</p></div>)}</div></div></section>

      <section className="mx-auto grid max-w-7xl gap-12 px-6 py-24 lg:grid-cols-[1fr_0.9fr] lg:px-10"><div><div className="mb-5 flex items-center gap-3 font-jetbrains-mono text-xs text-[#35D0C0]"><Bot className="size-4" /> AGENT-READY BY DESIGN</div><h2 className="font-space-grotesk text-4xl font-semibold tracking-tight sm:text-5xl">The cabinet also<br />speaks to agents.</h2><p className="mt-6 max-w-xl text-lg leading-relaxed text-[#8890A0]">An autonomous agent can have an Agent Wallet, a daily limit, and the same payment experience as a human. No login. No manual approval per game. Just protocol and score.</p><Link href="/play" className="mt-8 inline-flex items-center gap-2 font-space-grotesk font-semibold text-[#35D0C0] hover:underline">Launch a game <ArrowUpRight className="size-4" /></Link></div><div className="border-l-2 border-[#35D0C0] bg-[#141922] p-6"><div className="mb-4 font-jetbrains-mono text-xs text-[#8890A0]">// agent instruction / daily cap: 2 SVP</div><pre className="overflow-x-auto font-jetbrains-mono text-xs leading-7 text-[#35D0C0]">{`const mission = {
  target: "svp-arcade",
  action: "play",
  budget: "0.1 SVP",
  strategy: "maximize reaction_score",
  on: "HTTP 402 → sign → retry"
}`}</pre></div></section>

      <footer className="border-t border-[#2a2e3a] px-6 py-8 lg:px-10"><div className="mx-auto flex max-w-7xl flex-col justify-between gap-4 font-jetbrains-mono text-[10px] text-[#8890A0] sm:flex-row"><span>SVP ARCADE / BUILT ON SVP CHAIN</span><span>CAUTION: THIS IS TESTNET MONEY</span></div></footer>
    </main>
    </>
  )
}

export { TerminalSequence }
