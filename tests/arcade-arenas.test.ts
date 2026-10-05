import { describe, expect, it } from 'vitest'
import { ARENAS, ARENA_IDS, arenaById, arenaByType, flatFeeWei, isPlayable, maxScoreFor, parseArenaParam, resolveArenaParam, PROTOCOL_FEE_FLAT_WEI } from '../lib/arcade-arenas'
import type { ArenaType } from '../lib/arcade-types'

// ─────────────────────────────────────────────────────────────────────────────
// El registro de arenas es la UNICA fuente de verdad del id numerico. Si se
// desincroniza del enum de ArcadeVaultV6 el symptom es silencioso: un score
// firmado para `medium` (1) se grabaria en la arena equivocada y el reparto del
// epoch daria el premio al jugador equivocado. Estos tests son la unica red
// que hay entre esa desincronizacion y el dinero.
// ─────────────────────────────────────────────────────────────────────────────

describe('arena ids coinciden con el enum de ArcadeVaultV6', () => {
  // ArcadeVaultV6: enum ArenaType { HUMAN, MEDIUM, HARD, AGENT } -> 0,1,2,3
  it('human es 0', () => expect(ARENA_IDS.human).toBe(0))
  it('medium es 1', () => expect(ARENA_IDS.medium).toBe(1))
  it('hard es 2', () => expect(ARENA_IDS.hard).toBe(2))

  // El punto mas facil de pasar por alto de toda la migracion: en V5 AGENT era 1
  // y pasa a ser 3. Un id persistido que significara agent ahora significa medium.
  it('agent pasa de 1 a 3', () => expect(ARENA_IDS.agent).toBe(3))
  it('agent ya no colisiona con medium', () => expect(ARENA_IDS.agent).not.toBe(ARENA_IDS.medium))
})

describe('registro de arenas', () => {
  it('cubre exactamente los cuatro tipos de ArenaType', () => {
    const declared = Object.keys(ARENA_IDS).sort()
    const registered = ARENAS.map((a) => a.type).sort()
    expect(registered).toEqual(declared)
  })

  it('arenaByType y arenaById son inversas para toda arena registrada', () => {
    for (const arena of ARENAS) {
      expect(arenaByType(arena.type)?.id).toBe(arena.id)
      expect(arenaById(arena.id)?.type).toBe(arena.type)
    }
  })

  it('no hay ids duplicados', () => {
    const ids = ARENAS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('toda arena tiene etiqueta legible y fee positivo', () => {
    for (const arena of ARENAS) {
      expect(arena.label.length).toBeGreaterThan(0)
      expect(arena.entryFeeWei).toBeGreaterThan(BigInt(0))
    }
  })

  it('solo human es jugable: agent quedo fuera de alcance', () => {
    expect(isPlayable('human')).toBe(true)
    expect(isPlayable('medium')).toBe(true)
    expect(isPlayable('hard')).toBe(true)
    expect(isPlayable('agent')).toBe(false)
  })

  it('devuelve undefined para un tipo o id desconocidos en vez de inventar uno', () => {
    expect(arenaByType('nope' as ArenaType)).toBeUndefined()
    expect(arenaById(9 as 0)).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// El fee plano de 0.02 es una decision de producto: el staker recibe lo mismo
// por entrada en los tres modos, y ese mismo numero se reproduce con bps
// distintos por arena. Si alguien cambia un fee sin recalcular el bps, el
// ingreso del staking cambia de forma invisible. De ahi el test.
// ─────────────────────────────────────────────────────────────────────────────
describe('el fee plano de 0.02 se reproduce con bps por arena', () => {
  it('PROTOCOL_FEE_FLAT_WEI son 0.02 SVP', () => {
    expect(PROTOCOL_FEE_FLAT_WEI).toBe(BigInt('20000000000000000'))
  })

  it('cada arena jugable produce exactamente el mismo fee plano', () => {
    for (const arena of ARENAS) {
      if (!isPlayable(arena.type)) continue
      expect(flatFeeWei(arena)).toBe(PROTOCOL_FEE_FLAT_WEI)
    }
  })

  it('los bps son los esperados: 2000 human, 400 medium, 200 hard', () => {
    expect(arenaByType('human')!.protocolFeeBps).toBe(2000)
    expect(arenaByType('medium')!.protocolFeeBps).toBe(400)
    expect(arenaByType('hard')!.protocolFeeBps).toBe(200)
  })

  it('el bps esta dentro del tope de 3000 del contrato', () => {
    // ArcadeVaultV6.MAX_PROTOCOL_FEE_BPS = 3000. Un bps mayor haria que
    // setProtocolFee revirtiera en la cadena y el deploy dejaria de funcionar.
    for (const arena of ARENAS) {
      expect(arena.protocolFeeBps).toBeLessThanOrEqual(3000)
    }
  })

  it('agent tiene fee nominal: existe en la BD aunque no sea jugable', () => {
    // No puede ser 0 porque el registro se usa para validar constraints y el
    // contrato reserva el id aunque este apagado.
    expect(arenaByType('agent')!.entryFeeWei).toBeGreaterThan(BigInt(0))
  })
})

describe('puntuacion maxima derivada, no cableada', () => {
  it('human conserva el maximo historico de 24000', () => {
    // MAX_SCORE estaba escrito a mano como 60 * 400. Si el score por evento
    // cambia y nadie actualiza esa constante, el limite queda o demasiado
    // alto (acepta score imposible) o demasiado bajo (rechaza partidas
    // legitimas). Derivarlo elimina la clase entera de bug.
    expect(maxScoreFor('human')).toBe(24000)
  })

  it('el maximo es siempre eventos * (base + ventana * bonus)', () => {
    for (const arena of ARENAS) {
      const g = arena.gameplay
      const perEvent = g.scoring.base + g.scoring.decayWindowSeconds * g.scoring.bonusPerSecond
      expect(maxScoreFor(arena.type)).toBe(g.maxEvents * perEvent)
    }
  })

  it('ningun evento puede valer mas que el maximo derivado', () => {
    for (const arena of ARENAS) {
      const g = arena.gameplay
      const best = g.scoring.base + g.scoring.decayWindowSeconds * g.scoring.bonusPerSecond
      expect(best).toBeLessThanOrEqual(maxScoreFor(arena.type))
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// La dificultad tiene que ser monotona y explicable. Si hard fuera mas facil
// que medium, el modo caro estaria pagando por una experiencia peor.
// ─────────────────────────────────────────────────────────────────────────────
describe('la dificultad escala con el coste de la entrada', () => {
  it('hard cobra mas que medium, que cobra mas que human', () => {
    expect(arenaByType('hard')!.entryFeeWei).toBeGreaterThan(arenaByType('medium')!.entryFeeWei)
    expect(arenaByType('medium')!.entryFeeWei).toBeGreaterThan(arenaByType('human')!.entryFeeWei)
  })

  it('la ventana de bonus se acorta al subir la dificultad', () => {
    const human = arenaByType('human')!.gameplay.scoring.decayWindowSeconds
    const medium = arenaByType('medium')!.gameplay.scoring.decayWindowSeconds
    const hard = arenaByType('hard')!.gameplay.scoring.decayWindowSeconds
    expect(medium).toBeLessThan(human)
    expect(hard).toBeLessThan(medium)
  })

  it('la tolerancia del target se estrecha al subir la dificultad', () => {
    // Valores fijos, no solo ordenados. La tolerancia paso de 4/3/2 a 6/5/4 en la Etapa 5 porque
    // hasta entonces NO DECIDIA NADA: `hitTarget` escribia la posicion de la diana en cada evento,
    // asi que todo clic validaba y el campo era decorativo. Al registrar la posicion real del clic
    // paso a decidir puntos, y medido 4/3/2 daba una zona de 28x18px en `hard` con un circulo visible
    // de 48px: se podia clicar dentro de lo que se veia y no puntuar nada, sin forma de saberlo.
    //
    // La tabla de lo que 6/5/4 da, y de lo que NO da, esta en el comentario de `targetTolerance` en
    // lib/arcade-arenas.ts. En resumen: llega a 44px en ambos ejes solo en escritorio y solo en
    // `human`, porque una tolerancia en porcentaje no puede ser a la vez objetivo tactil en un movil
    // de 340px y juego de punteria. Fijar estos numeros aqui hace que subirlos sea una decision
    // consciente y no un descuido al tocar el registro.
    const human = arenaByType('human')!.gameplay.targetTolerance
    const medium = arenaByType('medium')!.gameplay.targetTolerance
    const hard = arenaByType('hard')!.gameplay.targetTolerance
    expect(human).toBe(6)
    expect(medium).toBe(5)
    expect(hard).toBe(4)
    expect(medium).toBeLessThan(human)
    expect(hard).toBeLessThan(medium)
    // Y ningun radio puede salirse del area: con un radio del 13% el 26% del ancho, el centro de la
    // diana en el extremo de `targetRange` se saldria del area en `human` (12..88 sobre un eje de
    // 100). Esto no es hipotetico: es lo que pasaria al subir la tolerancia tanto como haria falta
    // para alcanzar el minimo tactil en movil.
    for (const arena of ARENAS.filter((entry) => entry.playable)) {
      const rules = arena.gameplay
      expect(rules.targetTolerance * 2).toBeLessThanOrEqual(rules.targetRange.minX)
      expect(rules.targetTolerance * 2).toBeLessThanOrEqual(100 - rules.targetRange.maxX)
      expect(rules.targetTolerance * 2).toBeLessThanOrEqual(rules.targetRange.minY)
      expect(rules.targetTolerance * 2).toBeLessThanOrEqual(100 - rules.targetRange.maxY)
    }
  })

  it('el tope de entradas baja al subir la dificultad', () => {
    // Sin tope, el top-10 se compra repitiendo entradas. 50/20/10.
    expect(arenaByType('human')!.maxEntries).toBe(50)
    expect(arenaByType('medium')!.maxEntries).toBe(20)
    expect(arenaByType('hard')!.maxEntries).toBe(10)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// El escudo es la unica defensa contra perder una partida entera, asi que sus
// limites tienen que ser derivables y no numeros sueltos en el cliente.
// ─────────────────────────────────────────────────────────────────────────────
describe('escudo', () => {
  it('human no tiene escudo: es el modo de referencia sin mecanicas extra', () => {
    expect(arenaByType('human')!.gameplay.shield).toBeNull()
  })

  it('los modos con escudo duran 10s', () => {
    expect(arenaByType('medium')!.gameplay.shield?.durationMs).toBe(10_000)
    expect(arenaByType('hard')!.gameplay.shield?.durationMs).toBe(10_000)
  })

  it('no se puede activar en los ultimos 10s', () => {
    for (const type of ['medium', 'hard'] as const) {
      const shield = arenaByType(type)!.gameplay.shield!
      expect(shield.cannotActivateAfterMs).toBe(shield.durationMs)
      expect(shield.cannotActivateAfterMs).toBe(10_000)
    }
  })

  it('el escudo dura lo que la ventana de activacion: no hay caso imposible', () => {
    // Si noActivateAfter fuera mayor que la duracion total, el escudo nunca
    // podria activarse y el jugador perderia la partida sin margen.
    for (const type of ['medium', 'hard'] as const) {
      const arena = arenaByType(type)!
      const shield = arena.gameplay.shield!
      expect(shield.cannotActivateAfterMs).toBeLessThan(arena.gameplay.maxDurationMs)
    }
  })
})
describe('parseArenaParam: la puerta de entrada de elegir modo', () => {
  // `parseArenaParam` es lo que decide que arena se cobra. Lo usan las cuatro superficies de
  // usuario (`/play`, `/leaderboard`, `/incentive`, la portada, via ArenaTabs) y las rutas del
  // servidor que leen `?arena=`. Un fallo aqui no es un error de validacion: es 0.5 SVP cobrados
  // por una partida de human.
  //
  // La distincion que mas importa, y que no es evidente leyendo el cuerpo de la funcion, es
  // entre `undefined` por lo INVALIDO y `undefined` por lo AUSENTE. La UI y las rutas traducen
  // `undefined` a `human`, asi que un `?arena=inventado` que se aceptara por error compraria
  // human en silencio en vez de decir que el modo no existe.

  it('acepta el nombre de cada modo jugable', () => {
    expect(parseArenaParam('human')).toBe('human')
    expect(parseArenaParam('medium')).toBe('medium')
    expect(parseArenaParam('hard')).toBe('hard')
  })

  it('acepta el id numerico de cada modo jugable', () => {
    expect(parseArenaParam('0')).toBe('human')
    expect(parseArenaParam('1')).toBe('medium')
    expect(parseArenaParam('2')).toBe('hard')
  })

  it('el id 1 es MEDIUM, no AGENT: es la renumeracion vista desde la URL', () => {
    // Este es el test que falla si alguien vuelve a poner `agent: 1` en el registro. Bajo V5 el 1
    // era agent; en V6 es medium. Quien tenga un enlace guardado con `?arena=1` debe seguir
    // jugando al modo que el contrato ahora llama 1, y ese es medium.
    expect(parseArenaParam('1')).toBe('medium')
    expect(parseArenaParam('1')).not.toBe('agent')
  })

  it('rechaza agent por nombre y por id, aunque el id exista en el enum', () => {
    expect(ARENA_IDS.agent).toBe(3)
    expect(parseArenaParam('agent')).toBeUndefined()
    // El 3 es un id valido del contrato. Lo que lo hace no jugable es `playable: false` en el
    // registro, no que el id este fuera de rango: si la comprobacion se apoyara en el rango,
    // `/play?arena=3` devolveria 402 y el jugador pagaria por una arena que aun no existe.
    expect(parseArenaParam('3')).toBeUndefined()
  })

  it('rechaza lo que no es ni nombre ni id numerico', () => {
    for (const raw of ['', '   ', 'inventado', '0x0', '4', '99', '-1', '1.5', '1e0', 'medium,hard', 'medium hard']) {
      expect(parseArenaParam(raw), 'deberia rechazar ' + JSON.stringify(raw)).toBeUndefined()
    }
  })

  it('lo ausente no lanza: la diferencia entre ausente e invalido la hace el llamante', () => {
    expect(parseArenaParam(null)).toBeUndefined()
    expect(parseArenaParam(undefined)).toBeUndefined()
    // La ausencia es el caso normal de un enlace sin parametros y se resuelve a human. La
    // invalidez es un error. El fixture no puede distinguirlos porque los dos son undefined; lo
    // que fija este test es que ninguno de los dos revienta.
    expect(() => parseArenaParam(null)).not.toThrow()
    expect(() => parseArenaParam('nada-de-esto')).not.toThrow()
  })

  it('normaliza espacios y mayusculas, como llega una query de verdad', () => {
    expect(parseArenaParam('  medium  ')).toBe('medium')
    expect(parseArenaParam('HUMAN')).toBe('human')
    expect(parseArenaParam(' Medium ')).toBe('medium')
  })

  it('ida y vuelta: cada modo jugable se recupera por su nombre y por su id', () => {
    // El invariante que ata la URL con el registro. El test anterior sobre el 1 avisa de la
    // renumeracion concreta; este cubre el caso general, que es anadir un modo nuevo y que el
    // enlace para el exista sin tocar el parser.
    for (const arena of ARENAS.filter((entry) => entry.playable)) {
      expect(parseArenaParam(arena.type), 'por nombre: ' + arena.type).toBe(arena.type)
      expect(parseArenaParam(String(arena.id)), 'por id: ' + arena.id).toBe(arena.type)
    }
  })

  it('cubre exactamente los modos jugables: ni uno mas ni uno menos', () => {
    // Al reves del anterior. Nada fuera del registro puede colarse por la URL: si el parser
    // aceptara un tipo que el registro no declara jugable, apareceria aqui como elemento extra.
    const parsed = new Set(
      [...ARENAS.map((arena) => arena.type), ...ARENAS.map((arena) => String(arena.id))]
        .map((token) => parseArenaParam(token))
        .filter((type): type is ArenaType => type !== undefined),
    )
    expect([...parsed].sort()).toEqual(ARENAS.filter((arena) => arena.playable).map((arena) => arena.type).sort())
  })

  it('un modo desconocido NO cae a human dentro de parseArenaParam', () => {
    // La caida a human es responsabilidad de quien llama (`?? 'human'`), y a proposito se decide
    // ahi para poder distinguir "no se pidio modo" de "se pidio uno que no existe". Si esta
    // funcion devolviera 'human' ante basura, las cuatro superficies perderian el aviso de modo
    // desconocido y comprarian la entrada equivocada sin decir nada.
    expect(parseArenaParam('esto-no-es-un-modo')).toBeUndefined()
    expect(parseArenaParam('agent')).toBeUndefined()
  })
})

describe('resolveArenaParam: ausente cae, invalido se rechaza', () => {
  // Esta es la regla que hace que un `?arena=inventado` no devuelva una lista coherente y
  // equivocada. La diferencia entre "no me digas que modo" y "te pido un modo que no existe" es
  // exactamente la diferencia entre 200 con los datos de human y 400 diciendo que el modo no vale.
  // `parseArenaParam` no puede decidirlo porque devuelve `undefined` en los dos casos.

  it('sin parametro devuelve el fallback y lo marca como default', () => {
    const result = resolveArenaParam(null)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('se esperaba ok')
    expect(result.arena.type).toBe('human')
    // La marca es lo que permite a quien llama distinguir "pidio human" de "no dijo nada".
    expect(result.fromDefault).toBe(true)
  })

  it('el fallback por defecto es human, el unico modo que un cliente antiguo puede pedir', () => {
    const result = resolveArenaParam(undefined)
    expect(result.ok && result.arena.type).toBe('human')
  })

  it('un modo valido NO es default', () => {
    const result = resolveArenaParam('medium')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('se esperaba ok')
    expect(result.arena.type).toBe('medium')
    // El punto: si esto fuera `true`, el log diria "usando human" en una peticion que si lo dijo.
    expect(result.fromDefault).toBe(false)
  })

  it('un modo desconocido se RECHAZA en vez de caer al fallback', () => {
    // El fallo que importa. Con `?? 'human'` esto devolveria los reclamos de human con 200.
    for (const raw of ['inventado', 'agent', '3', '4', '0x0', '-1', 'medium,hard']) {
      const result = resolveArenaParam(raw)
      expect(result.ok, 'deberia rechazar ' + JSON.stringify(raw)).toBe(false)
    }
  })

  it('`?arena=` vacio cuenta como ausente, no como modo invalido', () => {
    // El jugador escribio el nombre del parametro y se le olvidó el valor. Rechazarlo con 400 seria
    // un 400 tan poco informativo como el que evita; darle human es lo que quiso decir.
    for (const raw of ['', '   ']) {
      const result = resolveArenaParam(raw)
      expect(result.ok, 'deberia aceptar ' + JSON.stringify(raw)).toBe(true)
      if (!result.ok) throw new Error('se esperaba ok')
      expect(result.fromDefault).toBe(true)
    }
  })

  it('el id numerico es un modo valido, no un modo inventado', () => {
    // `?arena=1` es medium y tiene que pasar por la misma puerta que `?arena=medium`, con el mismo
    // criterio. Si el id se rechazara por ser numerico, los enlaces con id --que son los que se
    // comparten-- dejarian de funcionar solo para los modos que no sean human.
    const result = resolveArenaParam('1')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('se esperaba ok')
    expect(result.arena.type).toBe('medium')
    expect(result.arena.id).toBe(1)
    expect(result.fromDefault).toBe(false)
  })

  it('un fallback que no es jugable lanza, no devuelve un 400', () => {
    // `agent` es un id valido del enum pero no es jugable. Pasarlo como fallback seria un error de
    // programacion; devolver un 400 lo camuflaria como una peticion mala y el bug pasaria anos.
    expect(() => resolveArenaParam(null, 'agent')).toThrow(/UNPLAYABLE_ARENA_FALLBACK/)
  })

  it('el fallback default de la firma es human y es jugable', () => {
    // Contraparte del anterior: el valor por defecto de la propia funcion no puede lanzar nunca.
    expect(() => resolveArenaParam(null)).not.toThrow()
  })

  it('el fallo lleva el valor crudo, para poder decir que se pidio sin filtrar el mensaje al cliente', () => {
    // `apiError` no debe incluirlo (el mensaje al cliente es generico), pero el log si: sin el
    // valor crudo no hay forma de saber si fue un typo o alguien probando.
    const result = resolveArenaParam('Medium-typo')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('se esperaba fallo')
    expect(result.raw).toBe('Medium-typo')
  })
})
