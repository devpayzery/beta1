import 'server-only'
import type { Address } from 'viem'
import { createAdminClient } from '@/lib/supabase/admin'
import type { ArenaId } from './arcade-arenas'

/**
 *(`import 'server-only'` a proposito: este modulo lee y escribe filas, y vitest no puede importarlo. La
 * parte que decide si una activacion es valida esta en `lib/booster-validation.ts`, que es puro y si
 * se testea. Aqui solo queda el estado, que no se puede probar sin Postgres.
 */

/**
 * Cuantas unidades tiene este wallet para esta arena. Lo lee `boosterValidationError` como
 * `availableUnits`.
 *
 * El `count` viene de la tabla y NUNCA del cuerpo de la peticion. Es el unico punto donde se decide
 * si el 2x es de pago o gratis, asi que si este numero viniera del cliente, declararlo en 1
 * permitiria 60 activaciones por partida y un 2x sin comprar nada.
 *
 * Se cuentan solo las filas `available` del wallet Y de la arena. Una unidad de `hard` no gasta la
 * de `medium`: cada unidad pertenece al modo con el que se compro, y la arena sale de la sesion,
 * que a su vez la fijo el pago. Contar unidades de cualquier modo permitiria comprar un solo booster
 * y gastarlo en las tres arenas.
 */
export async function availableBoosterUnits(wallet: Address, arena: ArenaId): Promise<number> {
  const { count, error } = await createAdminClient()
    .from('arcade_booster_units')
    .select('id', { count: 'exact', head: true })
    .eq('wallet', wallet.toLowerCase())
    .eq('arena', arena)
    .eq('status', 'available')
  if (error) throw error
  return count ?? 0
}

/**
 * Gasta `count` unidades del wallet para la arena. Devuelve `false` si no habia suficientes, sin
 * haber tocado ninguna fila.
 *
 * El gasto es un CAS por unidad: `update ... where status = 'available'`. Con eso dos Finish
 * concurrentes que compiten por la ultima unidad NO pueden gastarla los dos —el segundo hace match
 * de 0 filas— y no hace falta un cerrojo ni una transaccion que abarque mas de una tabla. Es el
 * mismo modelo que `session-store.transitionSession`, y por el mismo motivo: que la fila ya no este
 * en el estado esperado es, en si mismo, la senal de conflicto.
 *
 * Los VYNAR NO se pagan aqui. El 2x no se compra al activar: se compro antes (via BoosterVault, con
 * EIP-3009 por HTTP 402) y aqui solo se consume el derecho ya pagado. Si el BoosterVault pagase en
 * este punto, un cliente podria activar un booster y cerrar la pestana antes de que la transaccion
 * llegara, y el CAS no lo impediria.
 */
export async function consumeBoosterUnit(wallet: Address, arena: ArenaId, count: number): Promise<boolean> {
  if (count <= 0) return true
  const db = createAdminClient()
  // Selecting the ids BEFORE updating avoids an UPDATE ... WHERE status='available' that
  // would affect more rows than the player asked for: `limit` doesn't exist in an UPDATE of
  // PostgREST, so a `count` of 3 on a balance of 10 would spend 10.
  const { data, error } = await db.from('arcade_booster_units').select('id').eq('wallet', wallet.toLowerCase()).eq('arena', arena).eq('status', 'available').limit(count)
  if (error) throw error
  if (!data || data.length < count) return false
  const ids = data.map((row) => row.id as string)
  const { data: consumed, error: consumeError } = await db
    .from('arcade_booster_units')
    .update({ status: 'consumed', consumed_at: new Date().toISOString() })
    .in('id', ids)
    .eq('status', 'available')
    .select('id')
  if (consumeError) throw consumeError
  // If the number of updated rows doesn't match the request, another request took some ahead.
  // We return `false` instead of leaving a half-spend: the round is rejected with a 409 and the
  // player doesn't lose VYNAR for a race they didn't win.
  return consumed?.length === count
}
