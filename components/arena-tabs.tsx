'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ARENAS, arenaByType, parseArenaParam } from '@/lib/arcade-arenas'

/**
 * Selector de modo, compartido por la portada, /play, /leaderboard e /incentive.
 *
 * El modo viaja en la URL porque la URL es la fuente de verdad de que hay que pagar por el modo
 * que se cree: el `payToPlay` se firma con el id que el cliente lee de ahi y `/api/play` lo vuelve a
 * leer en el servidor antes de cobrar. Un selector que guardara el modo en un estado de React
 * dejaria la direccion mintiendo, y con ella cualquier recarga, enlace compartido o boton atras.
 *
 * Se conservan los demas parametros de la query al cambiar de modo, para que anadir `?epoch=` o
 * `?claim=` mas adelante no se pierda al pulsar otra arena.
 *
 * `locked` es lo que usa /play mientras hay partida en curso. El modo ya esta congelado por sesion
 * (ver el doc de `requestPlay` en app/play/page.tsx), asi que el juego seguiria siendo correcto,
 * pero la URL passaria a anunciar un modo mientras el marcador y las reglas son los de otro:
 * exactamente la confusion que el congelado existe para evitar. No se quita el enlace, se marca:
 * quitarlo del DOM haria que el tablossaltara al navegar con teclado justo cuando el jugador
 * quiere cambiar de opinion antes de la siguiente ronda.
 *
 * Un componente y no cuatro copias: la lista de modos jugables sale de `ARENAS`, asi que anadir un
 * modo al registro lo anade aqui sin tocar ninguna pagina. Con cuatro copias, olvidar una es el
 * estado normal, no la excepcion.
 */
export function ArenaTabs({ basePath, accent = '#F5B935', locked = false }: { basePath: string; accent?: string; locked?: boolean }) {
  const params = useSearchParams()
  const current = parseArenaParam(params.get('arena')) ?? 'human'
  const currentConfig = arenaByType(current)

  return (
    <nav aria-label="Modo de juego" className="flex flex-wrap items-center gap-2">
      <span className="font-jetbrains-mono text-[10px] uppercase tracking-widest text-[#8890A0]">Mode</span>
      <ul className="flex flex-wrap items-center gap-2">
        {ARENAS.filter((arena) => arena.playable).map((arena) => {
          const active = arena.type === current
          // Con la partida en curso el modo activo sigue siendo un enlace: es el que se esta
          // jugando y debe poder releerse. Los demas se inertizan con aria-disabled y no con
          // `disabled`, que en un <a> no existe y ademas sacaria el elemento del orden de tabulado.
          const inert = locked && !active
          const next = new URLSearchParams(params.toString())
          next.set('arena', arena.type)
          return (
            <li key={arena.type}>
              <Link
                href={`${basePath}?${next.toString()}`}
                aria-current={active ? 'page' : undefined}
                aria-disabled={inert || undefined}
                tabIndex={inert ? -1 : undefined}
                onClick={inert ? (event) => event.preventDefault() : undefined}
                style={active ? { borderColor: accent, color: accent } : undefined}
                className={`inline-block border px-3 py-1 font-jetbrains-mono text-[11px] uppercase tracking-wider transition-colors ${active ? '' : 'border-[#2a2e3a] text-[#8890A0] hover:border-[#5a6270] hover:text-[#ECEEF2]'}${inert ? ' pointer-events-none opacity-40' : ''}`}
              >
                {arena.label}
              </Link>
            </li>
          )
        })}
      </ul>
      {currentConfig && (
        <span className="font-jetbrains-mono text-[11px] text-[#8890A0]">
          id {currentConfig.id} / {Math.round(currentConfig.gameplay.maxDurationMs / 1000)}s
        </span>
      )}
    </nav>
  )
}