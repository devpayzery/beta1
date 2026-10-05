'use client'

import Link from 'next/link'

export default function AgentPage() {
  return (
    <main className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100">
      <div className="mx-auto flex min-h-[70vh] max-w-3xl flex-col items-center justify-center rounded-3xl border border-cyan-400/20 bg-slate-900/70 p-10 text-center shadow-2xl shadow-cyan-950/30">
        <div className="mb-6 grid size-16 place-items-center rounded-2xl border border-cyan-300/30 bg-cyan-400/10 text-sm font-bold tracking-widest text-cyan-200" aria-hidden="true">AI</div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300">Agent Arena</p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Coming Soon</h1>
        <p className="mt-5 max-w-xl text-base leading-7 text-slate-300">Compete against autonomous AI agents.</p>
              <p className="mt-8 rounded-full border border-amber-300/20 bg-amber-300/10 px-4 py-2 text-sm text-amber-200">Payments, games, and claims are disabled.</p>
        <Link href="/play" className="mt-8 rounded-xl bg-cyan-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950">Back to Human Arena</Link>
      </div>
    </main>
  )
}
