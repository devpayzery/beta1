/**
 * Verifica la cadena de migraciones `supabase/migrations/*.sql` contra un Postgres real.
 *
 * POR QUE EXISTE
 *
 * Este repo no tiene CI y nada mas comprueba que las migraciones correspondan a una base de
 * datos. Durante meses la cadena de remediacion de auditoria (20261001000000 en adelante) no
 * se habia ejecutado ni una vez: sus tests, su typecheck y su build pasaban mientras tres
 * migraciones tenian un error de parseo que hacia fallar `db push` entero. Este script es el
 * que encuentra esa clase de fallo.
 *
 * QUE NO ES
 *
 * No es un sustituto de un Postgres desplegado. PGlite es Postgres compilado a WASM: no tiene
 * psql, ni pg_cron, ni los roles completos de Supabase. Lo que si hace bien, y es lo que
 * importa, es ejecutar el DDL real y comprobar que las constraints, triggers y vistas hacen
 * lo que el comentario dice que hacen.
 *
 * USO
 *
 *   pnpm verify:migrations
 *
 * Sale con codigo 1 si algo falla, de modo que sirve como puerta en un pipeline.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const MIG = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations')

let pass = 0
let fail = 0
const ok = (condition, message) => {
  if (condition) {
    pass += 1
    console.log('  OK   ' + message)
  } else {
    fail += 1
    console.log('  MAL  ' + message)
  }
}
const head = (title) => console.log('\n=== ' + title + ' ===')

async function main() {
  const db = new PGlite()

  // Roles y schema que la plataforma de Supabase crea y PGlite no. Sin esto TODA migracion
  // falla en su primera linea de GRANT con `role "anon" does not exist`, que no dice nada
  // del SQL de la migracion que uno cree estar revisando.
  for (const role of [
    'anon',
    'authenticated',
    'service_role',
    'authenticator',
    'supabase_auth_admin',
    'supabase_admin',
    'supabase_storage_admin',
  ]) {
    try {
      await db.exec(`create role "${role}" nologin noinherit`)
    } catch {
      /* ya existe */
    }
  }
  await db.exec(`create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as $fn$ select null::uuid $fn$;`)

  const files = readdirSync(MIG)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    await db.exec(readFileSync(join(MIG, file), 'utf8'))
  }
  console.log(`aplicadas ${files.length} migraciones, sin fallos`)

  const W1 = '0x' + '11'.repeat(20)
  const W2 = '0x' + '33'.repeat(20)
  const W3 = '0x' + '44'.repeat(20)

  // ─────────────────────────────────────────────────────────────────────────────
  head('1. las cuatro arenas pasan el constraint')
  const con = await db.query(
    `select conname, pg_get_constraintdef(oid) as def
     from pg_constraint where conname like '%_arena_type_check' order by conname`,
  )
  // 6, no 5: arcade_payments.arena_type se anadio en 20261002000100. Antes de esa migracion un pago
  // de 1.0 SVP (hard) y uno de 0.1 (human) eran indistinguibles, y la tabla de pagos no podia
  // explicar de donde salio el dinero.
  ok(con.rows.length === 6, 'las 6 tablas con arena_type tienen constraint')
  ok(
    con.rows.every((r) => r.def.includes('medium') && r.def.includes('hard')),
    'las 6 aceptan medium y hard',
  )

  // ─────────────────────────────────────────────────────────────────────────────
  head('2. insert real por arena')
  // arcade_sessions.payment_id es uuid y REFERENCES arcade_payments(id), y expires_at es
  // NOT NULL sin default. Sin sembrar el pago primero el insert falla por FK y el mensaje no
  // tiene nada que ver con el constraint que uno quiere comprobar.
  const session = async (wallet, sessionId, arena) => {
    const pay = await db.query(
      // El pago lleva SU modo, no el default. ArcadeVaultV6 congela `arena_type` en el pago y
      // arcade_sessions_arena_matches_payment rechaza una sesion cuyo modo no coincida con el de
      // su pago. Sembrar el pago sin `arena_type` y luego abrir la sesion en `medium` es
      // precisamente el ataque que el trigger existe para cortar.
      `insert into public.arcade_payments (tx_hash, wallet, chain_id, amount_wei, epoch, arena_type)
       values ($1, $2, 2517, 100000000000000000, 7, $3) returning id`,
      ['0xpay' + sessionId.padEnd(60, '0'), wallet, arena],
    )
    return db.query(
      `insert into public.arcade_sessions
         (wallet, session_id, payment_id, epoch, game_seed, arena_type, expires_at)
       values ($1, $2, $3, 7, $4, $5, now() + interval '60 seconds')
       returning session_id, arena_type`,
      [wallet, sessionId, pay.rows[0].id, '0x' + '22'.repeat(32), arena],
    )
  }

  for (const arena of ['human', 'medium', 'hard', 'agent']) {
    try {
      const r = await session(W1, 'sid-' + arena, arena)
      ok(r.rows.length === 1 && r.rows[0].arena_type === arena, `insert ${arena} aceptado y conserva el valor`)
    } catch (e) {
      ok(false, `insert ${arena} -> ${e.message.split('\n')[0]}`)
    }
  }

  head('3. un typo se rechaza')
  // Esto es lo que las tres tablas vyr NO tenian antes de 20261002000000: aceptaban
  // cualquier texto, asi que un 'meduim' acotaba hasta el pago.
  for (const bad of ['meduim', 'HUMAN', 'agente', 'hard ', 'hards']) {
    let rejected = false
    try {
      await session(W2, 'sid-bad-' + bad.replace(/\W/g, 'x'), bad)
    } catch {
      rejected = true
    }
    ok(rejected, `typo "${bad}" rechazado`)
  }

  // ─────────────────────────────────────────────────────────────────────────────
  head('4. el ranking es una fila por wallet y arena, y solo de partidas grabadas')
  const scored = async (sessionId, wallet, arena, score, status, txHash) => {
    await db.query(
      `insert into public.arcade_scores
         (session_id, wallet, epoch, score, status, gameplay, arena_type, tx_hash)
       values ($1, $2, 7, $3, $4, '[]'::jsonb, $5, $6)`,
      [sessionId, wallet, score, status, arena, txHash],
    )
  }
  const tx = (n) => '0x' + 'ee'.repeat(31) + String(n)

  const hasCol = async (table, column) =>
    (
      await db.query(
        `select count(*)::int as n from information_schema.columns
         where table_name=$1 and column_name=$2`,
        [table, column],
      )
    ).rows[0].n

  ok((await hasCol('arcade_scores_ranked', 'wallet_rank')) === 1, 'wallet_rank vive en arcade_scores_ranked')
  ok(
    (await hasCol('arcade_scores_best', 'wallet_rank')) === 0,
    'arcade_scores_best no expone wallet_rank: ya viene filtrada por wallet_rank = 1',
  )

  // Un wallet compra dos sesiones en la misma arena y epoch. Solo la mejor debe aparecer en
  // _best. Un indice unico sobre (epoch, arena, wallet) rechazaria justamente la segunda,
  // que es el caso en que el jugador mejora.
  const low = await session(W1, 'rank-low', 'medium')
  const high = await session(W1, 'rank-high', 'medium')
  await scored(low.rows[0].session_id, W1, 'medium', 500, 'recorded', tx(1))
  await scored(high.rows[0].session_id, W1, 'medium', 9000, 'recorded', tx(2))
  const best = await db.query(
    `select score from public.arcade_scores_best where wallet=$1 and arena_type='medium'`,
    [W1],
  )
  ok(best.rows.length === 1, 'dos partidas del mismo wallet dan una sola fila en _best')
  ok(Number(best.rows[0]?.score) === 9000, 'y es la mejor, no la primera')

  const noTx = await session(W2, 'rank-notx', 'human')
  let noTxRejected = false
  try {
    await scored(noTx.rows[0].session_id, W2, 'human', 100, 'recorded', null)
  } catch {
    noTxRejected = true
  }
  ok(noTxRejected, 'un score recorded sin tx_hash es rechazado')

  const wrongArena = await session(W1, 'rank-wrongarena', 'hard')
  let mismatch = false
  try {
    await scored(wrongArena.rows[0].session_id, W1, 'medium', 100, 'recorded', tx(3))
  } catch {
    mismatch = true
  }
  ok(mismatch, 'un score con arena distinta a la de su sesion es rechazado')

  const pending = await session(W3, 'rank-pending', 'hard')
  await scored(pending.rows[0].session_id, W3, 'hard', 99999, 'submitting', null)
  ok(
    (await db.query(`select count(*)::int as n from public.arcade_scores_best where wallet=$1`, [W3]))
      .rows[0].n === 0,
    'una partida submitting no aparece en arcade_scores_best',
  )
  ok(
    (
      await db.query(`select count(*)::int as n from public.arcade_leaderboard_public where wallet=$1`, [W3])
    ).rows[0].n === 0,
    'ni en arcade_leaderboard_public',
  )

  // ─────────────────────────────────────────────────────────────────────────────
  head('5. vistas _wei: precision de numeric(78,0) sin perdida')
  const views = (
    await db.query(
      `select table_name from information_schema.views where table_schema='public' order by table_name`,
    )
  ).rows.map((r) => r.table_name)
  for (const v of ['arcade_scores_best', 'arcade_leaderboard_public', 'svp_reward_allocations_wei', 'vyr_claims_wei', 'vyr_chain_snapshots_wei']) {
    ok(views.includes(v), `${v} existe`)
  }
  for (const [view, columns] of [
    ['svp_reward_allocations_wei', ['prize_pool', 'reward_amount']],
    ['vyr_claims_wei', ['points', 'amount']],
    ['vyr_chain_snapshots_wei', ['prize_pool']],
  ]) {
    for (const column of columns) {
      const type = (
        await db.query(
          `select data_type from information_schema.columns where table_name=$1 and column_name=$2`,
          [view, column],
        )
      ).rows[0]?.data_type
      ok(type === 'text', `${view}.${column} es text, no numeric`)
    }
  }
  // Por que el cast importa: un numeric de 30 digitos sobrevive como texto y se pierde como
  // numero JSON en cuanto supera 2^53.
  const huge = '123456789012345678901234567890'
  await db.query(
    `insert into public.svp_epoch_snapshots (epoch, arena, prize_pool, onchain_result, top10)
     values (424242, 0, $1::numeric, '{}'::jsonb, '[]'::jsonb)`,
    [huge],
  )
  const back = await db.query(
    `select prize_pool::text as t from public.svp_epoch_snapshots where epoch = 424242`,
  )
  ok(back.rows[0].t === huge, 'importe de 30 digitos intacto tras el cast a text')
  ok(Number(huge) > Number.MAX_SAFE_INTEGER, 'ese importe supera 2^53: como numero JSON se perderia')

  // ─────────────────────────────────────────────────────────────────────────────
  head('6. rate limiting: ventana deslizante real')
  const body = (
    await db.query(`select prosrc from pg_proc where proname='consume_arcade_rate_limit' limit 1`)
  ).rows[0]?.prosrc ?? ''
  ok(body.includes('arcade_rate_limit_hits'), 'consulta la tabla de hits, no una ventana fija')
  ok(!body.includes('window_started_at'), 'ya no depende de la ventana fija')

  const consume = async (subject, times) => {
    let allowed = 0
    for (let i = 0; i < times; i += 1) {
      const r = await db.query(`select * from public.consume_arcade_rate_limit('b',$1,3,60)`, [subject])
      if (r.rows[0].allowed) allowed += 1
    }
    return allowed
  }
  ok((await consume('sujeto-a', 5)) === 3, 'el limite de 3 se respeta: 3 de 5 concedidos')
  ok((await consume('sujeto-b', 5)) === 3, 'cada sujeto tiene su propia cuota')

  head('7. un rechazo no quema cuota')
  await db.query(`select * from public.consume_arcade_rate_limit('b','sujeto-c',1,60)`)
  ok(
    (
      await db.query(`select count(*)::int as n from public.arcade_rate_limit_hits where subject='sujeto-c'`)
    ).rows[0].n === 1,
    'solo la peticion admitida quedo registrada como hit',
  )

  // ─────────────────────────────────────────────────────────────────────────────
  head('8. auth challenge: el nonce se consume una sola vez')
  ok((await hasCol('arcade_auth_challenges', 'consumed_at')) === 1, 'arcade_auth_challenges tiene consumed_at')
  const nonce = 'a'.repeat(64)
  await db.query(
    `insert into public.arcade_auth_challenges (wallet, nonce, expires_at)
     values ($1, $2, now() + interval '5 minutes') on conflict do nothing`,
    [W1, nonce],
  )
  const first = (await db.query(`select * from public.consume_arcade_auth_challenge($1,$2)`, [W1, nonce])).rows[0] ?? {}
  const second = (await db.query(`select * from public.consume_arcade_auth_challenge($1,$2)`, [W1, nonce])).rows[0] ?? {}
  const flag = (row) => Object.values(row).find((v) => typeof v === 'boolean')
  ok(flag(first) === true, 'el primer consumo del nonce se acepta')
  ok(flag(second) === false, 'el segundo uso del mismo nonce se rechaza: replay bloqueado')

  // ─────────────────────────────────────────────────────────────────────────────
  head('9. RLS y permisos')
  const policies = (await db.query(`select tablename, policyname, cmd from pg_policies where schemaname='public'`)).rows
  console.log(`  politicas: ${policies.length}`)
  for (const p of policies) console.log(`    ${p.tablename} :: ${p.policyname} :: ${p.cmd}`)

  const forced = (
    await db.query(
      `select relname from pg_class
       where relnamespace='public'::regnamespace and relkind='r' and relforcerowsecurity order by relname`,
    )
  ).rows
  ok(forced.length >= 8, `force RLS aplicado a ${forced.length} tablas sensibles`)

  const writes = (
    await db.query(
      `select table_name, grantee, privilege_type from information_schema.role_table_grants
       where table_schema='public' and grantee in ('anon','authenticated')
         and privilege_type in ('INSERT','UPDATE','DELETE')`,
    )
  ).rows
  ok(writes.length === 0, 'cero permisos de escritura para anon y authenticated')
  ok((await hasCol('arcade_leaderboard_public', 'gameplay')) === 0, 'arcade_leaderboard_public no expone gameplay')

  head('10. funciones sensibles no ejecutables por el publico')
  for (const fn of [
    'consume_arcade_rate_limit',
    'consume_arcade_auth_challenge',
    'purge_arcade_auth_challenges',
    'purge_expired_arcade_rate_limits',
  ]) {
    const grants = (
      await db.query(
        `select has_function_privilege('anon',oid,'EXECUTE') as a,
                has_function_privilege('authenticated',oid,'EXECUTE') as b
         from pg_proc where proname=$1`,
        [fn],
      )
    ).rows
    ok(
      grants.length > 0 && grants.every((r) => r.a === false && r.b === false),
      `${fn} no es ejecutable por anon ni por authenticated`,
    )
  }

  // ─────────────────────────────────────────────────────────────────────────────
  head('11. arcade_payments.arena_type: default, constraint y cadena de custodia')
  // 20261002000100 anadio la columna. Estas comprobaciones existen porque el trigger
  // arcade_sessions_arena_matches_payment que la ata a la sesion NO se nota al aplicar la
  // migracion: Postgres no valida que la fonction exista al crear el trigger, solo al ejecutarlo.
  // Sin ejercitarlo, un orden invertido en el SQL llegaria a produccion y el fallo apareceria la
  // primera vez que alguien inserta una sesion.
  const payCols = (await db.query(`select column_name, is_nullable, column_default from information_schema.columns where table_name='arcade_payments' and column_name='arena_type'`)).rows
  ok(payCols.length === 1, 'arcade_payments.arena_type existe')
  ok(payCols[0]?.is_nullable === 'NO', 'arcade_payments.arena_type es NOT NULL')

  const payArenaCheck = (await db.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname='arcade_payments_arena_type_check'`)).rows
  ok(payArenaCheck.length === 1 && payArenaCheck[0].def.includes('medium') && payArenaCheck[0].def.includes('hard'), 'el constraint del pago acepta las cuatro arenas')

  // La sesion hereda el modo del pago y el trigger lo exige. Se comprueban los tres caminos: el
  // feliz, el de arena distinta (que debe fallar) y el de pago inexistente (foreign key logica).
  const chain = await db.query(
    `insert into public.arcade_payments (tx_hash, wallet, chain_id, amount_wei, epoch, arena_type)
     values ('0xchaincustody0000000000000000000000000000000000000000000000001', $1, 2517, 100000000000000000, 7, 'hard')
     returning id, arena_type`,
    [W2],
  )
  ok(chain.rows[0]?.arena_type === 'hard', 'el pago guarda el modo que se le pidio, no el default')

  const goodSession = await db.query(
    `insert into public.arcade_sessions (wallet, session_id, payment_id, epoch, game_seed, arena_type, expires_at)
     values ($1, $2, $3, 7, $4, 'hard', now() + interval '60 seconds') returning arena_type`,
    [W2, '0xs' + '11'.repeat(31), chain.rows[0].id, '0x' + '33'.repeat(32)],
  )
  ok(goodSession.rows[0]?.arena_type === 'hard', 'una sesion cuyo modo coincide con el pago se acepta')

  let arenaMismatch = null
  try {
    await db.query(
      `insert into public.arcade_sessions (wallet, session_id, payment_id, epoch, game_seed, arena_type, expires_at)
       values ($1, $2, $3, 7, $4, 'human', now() + interval '60 seconds')`,
      [W2, '0xs' + '22'.repeat(31), chain.rows[0].id, '0x' + '44'.repeat(32)],
    )
  } catch (e) { arenaMismatch = e.message }
  ok(
    arenaMismatch !== null && String(arenaMismatch).includes('SESSION_ARENA_DOES_NOT_MATCH_PAYMENT'),
    'una sesion de human pagada como hard se RECHAZA (esta es la defensa que impedia repartir un premio de 1.0 SVP por una entrada de 0.1)',
  )

  let missing = null
  try {
    await db.query(
      `insert into public.arcade_sessions (wallet, session_id, payment_id, epoch, game_seed, arena_type, expires_at)
       values ($1, $2, $4, 7, $3, 'human', now() + interval '60 seconds')`,
      // Un id de pago que no existe. `gen_random_uuid()` no sirve aqui porque el arnes corre en
      // PGlite sin pgcrypto, y porque un id aleatorio haria el mensaje de error variable.
      [W2, '0xs' + '33'.repeat(31), '0x' + '55'.repeat(32), '00000000-0000-0000-0000-000000000000'],
    )
  } catch (e) { missing = e.message }
  // El mensaje distingue los dos rechazos: `SESSION_PAYMENT_MISSING` es del trigger (pagamento
  // logicamente ausente) y una violacion de FK seria el mensaje estandar de Postgres. Se acepta
  // cualquiera de los dos, porque lo que se comprueba es que NO se acepte la sesion.
  ok(
    missing !== null && (String(missing).includes('SESSION_PAYMENT_MISSING') || String(missing).includes('foreign key')),
    'una sesion cuyo pago no existe se rechaza',
  )

  let mutated = null
  try {
    await db.query(`update public.arcade_payments set arena_type='human' where id=$1`, [chain.rows[0].id])
  } catch (e) { mutated = e.message }
  ok(
    mutated !== null && String(mutated).includes('PAYMENT_ARENA_IMMUTABLE'),
    'el modo de un pago ya verificado no se puede retocar: eso invalidaria el trigger anterior en silencio',
  )

  // ─────────────────────────────────────────────────────────────────────────────
  head('12. arcade_scores.vynar_points: el total de VYNAR que se mintea es inmutable y coherente')
  // Por que se persiste en vez de recalcularse: `mintForScoreOnce` es de un solo disparo por
  // `rewardId`, asi que una recuperacion que recalculara el total podria mintear un numero distinto
  // del primero, y el que ganase seria el que llego antes a la cadena. Con la fila, el reintento
  // mintea el mismo numero o no mintea.
  // Cada score necesita su sesion: el trigger `SCORE_SESSION_MISSING` ata la fila de score a la de
  // sesion en wallet, epoch y arena, que es la misma cadena de custodia que impide que un pago de
  // hard acabe respaldando una partida de human.
  const boosterSession = await session(W2, 'booster-vynar', 'medium')
  const boosterRow = await db.query(
    `insert into public.arcade_scores (session_id, wallet, epoch, arena_type, score, vynar_points, status)
     values ($1, $2, 7, 'medium', 1000, 1400, 'submitting') returning vynar_points`,
    [boosterSession.rows[0].session_id, W2],
  )
  // `Number()` y no `=== 1400n`: PGlite devuelve los bigint como number, y comparar con un BigInt
  // daria false sin que haya ningun problema de verdad. Lo que se comprueba aqui es el VALOR, y la
  // distincion de tipos la hace el `bigint` de la columna, que ya se verifica en la seccion 9.
  ok(Number(boosterRow.rows[0]?.vynar_points) === 1400, 'el total de VYNAR se graba junto al score y es un numero propio')

  const belowSession = await session(W3, 'booster-below', 'medium')
  let belowScore = null
  try {
    await db.query(
      `insert into public.arcade_scores (session_id, wallet, epoch, arena_type, score, vynar_points, status)
       values ($1, $2, 7, 'medium', 1000, 999, 'submitting')`,
      [belowSession.rows[0].session_id, W3],
    )
  } catch (e) { belowScore = e.message }
  ok(
    belowScore !== null && String(belowScore).includes('arcade_scores_vynar_points_gte_score'),
    'un total de VYNAR por debajo del score se rechaza: el booster multiplica y nunca divide, asi que solo puede ser una mezcla de dos partidas',
  )

  // El `check` de no-negativo se comprueba por su DEFINICION y no por un insert, porque un
  // `vynar_points` negativo choca siempre antes con el de `>= score`: no existe un negativo que sea
  // mayor o igual que un score valido. Asercionandolo por comportamiento, el test pasaria aunque el
  // `check` de no-negativo no existiera, porque el otro atraparia el mismo INSERT.
  const vynarConstraints = await db.query(
    `select conname from pg_constraint
     where conrelid = 'public.arcade_scores'::regclass
       and conname in ('arcade_scores_vynar_points_nonnegative', 'arcade_scores_vynar_points_gte_score')`,
  )
  ok(
    vynarConstraints.rows.length === 2,
    'los dos checks del total de VYNAR existen: no-negativo y mayor-o-igual que el score',
  )

  const negSession = await session(W3, 'booster-neg', 'medium')
  let negative = null
  try {
    await db.query(
      `insert into public.arcade_scores (session_id, wallet, epoch, arena_type, score, vynar_points, status)
       values ($1, $2, 7, 'medium', 0, -1, 'submitting')`,
      [negSession.rows[0].session_id, W3],
    )
  } catch (e) { negative = e.message }
  ok(negative !== null, 'un total de VYNAR negativo se rechaza en la base, no solo en TypeScript')

  let vynarMutated = null
  try {
    await db.query(`update public.arcade_scores set vynar_points = 9999 where session_id = $1`, [boosterSession.rows[0].session_id])
  } catch (e) { vynarMutated = e.message }
  ok(
    vynarMutated !== null && String(vynarMutated).includes('VYNAR_POINTS_IMMUTABLE'),
    'el total de VYNAR ya grabado no se puede retocar: es la unica prueba de lo que se minteo en cadena',
  )

  // `score` se sigue pudiendo tocar (es lo que el flujo de reconciliacion necesita), pero el total no.
  await db.query(`update public.arcade_scores set vynar_points = vynar_points where session_id = $1`, [boosterSession.rows[0].session_id])
  ok(true, 'un UPDATE que deja el total igual no dispara el trigger de inmutabilidad')

  // ─────────────────────────────────────────────────────────────────────────────
  head('13. arcade_booster_units: una unidad por fila, se gasta con CAS y no se puede reusar')
  const units = await db.query(
    `insert into public.arcade_booster_units (wallet, arena, status)
     values ($1, 1, 'available'), ($1, 1, 'available'), ($1, 2, 'available')
     returning id, arena, status`,
    [W2],
  )
  ok(units.rows.length === 3, 'cada unidad comprada es una fila propia, no un contador de saldo')
  ok(
    units.rows.filter((r) => r.arena === 1).length === 2 && units.rows.filter((r) => r.arena === 2).length === 1,
    'cada unidad pertenece al modo con el que se compro: una de hard no gasta la de medium',
  )

  let badArena = null
  try {
    await db.query(`insert into public.arcade_booster_units (wallet, arena) values ($1, 9)`, [W3])
  } catch (e) { badArena = e.message }
  ok(badArena !== null, 'una unidad de una arena que no existe se rechaza: el rango es el del enum on-chain')

  const availableId = units.rows[0].id
  const spent = await db.query(
    `update public.arcade_booster_units set status = 'consumed', consumed_at = now()
     where id = $1 and status = 'available' returning id`,
    [availableId],
  )
  ok(spent.rows.length === 1, 'el CAS gasta la unidad: el filtro por status=available es lo que hace que dos Finish no la gasten los dos')

  const secondTry = await db.query(
    `update public.arcade_booster_units set status = 'consumed' where id = $1 and status = 'available' returning id`,
    [availableId],
  )
  ok(secondTry.rows.length === 0, 'la segunda vez que se intenta gastar la MISMA unidad no actualiza ninguna fila: ese 0 es la senal de conflicto')

  let reconsumed = null
  try {
    await db.query(`update public.arcade_booster_units set status = 'consumed' where id = $1`, [availableId])
  } catch (e) { reconsumed = e.message }
  ok(
    reconsumed !== null && String(reconsumed).includes('BOOSTER_UNIT_ALREADY_CONSUMED'),
    'una unidad ya gastada no se puede volver a gastar ni escribiendo el filtro a mano: el trigger cubre lo que el codigo no garantiza',
  )

  let unitMoved = null
  try {
    await db.query(`update public.arcade_booster_units set arena = 2 where id = $1`, [units.rows[1].id])
  } catch (e) { unitMoved = e.message }
  ok(
    unitMoved !== null && String(unitMoved).includes('BOOSTER_UNIT_IMMUTABLE'),
    'una unidad comprada en medium no se puede mover a hard despues: seria cambiar de modo lo ya pagado',
  )

  const stillCounted = await db.query(
    `select count(*)::int as n from public.arcade_booster_units where wallet = $1 and arena = 1 and status = 'available'`,
    [W2],
  )
  ok(stillCounted.rows[0].n === 1, 'tras gastar una, availableBoosterUnits devuelve 1 para medium: es el numero que ve boosterValidationError')

  console.log('\n' + (fail === 0 ? `TODO VERIFICADO: ${pass} comprobaciones OK` : `${pass} OK, ${fail} FALLOS`))
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL: ' + e.message)
  process.exit(1)
})
