-- arcade_scores.vynar_points y arcade_booster_units
--
-- POR QUE ESTA MIGRACION HACE FALTA
--
-- Los boosters duplican el VYNAR de una partida, y solo el VYNAR. El score sigue yendo entero a
-- `recordScore`, asi que rankings y premios no cambian por un booster. Eso esta bien, pero deja un
-- agujero de recuperacion que antes no existia.
--
-- `mintForScoreOnce` es de UN SOLO disparo por `rewardId`, y aqui el `rewardId` es el `sessionId`.
-- Si el primer intento de mint llega a la cadena y la confirmacion se pierde (timeout, reinicio),
-- la sesion queda en `submitting` y `app/api/play/finish` la reintenta por la rama de
-- `recoverScoreMint`. Esa rama necesita el MISMO total que se uso la primera vez. Si lo recalculara,
-- habria dos totales distintos para la misma partida, y el que se confirmara primero seria el que
-- llegara antes a la cadena: un resultado que depende del orden de dos transacciones, sin ningun
-- error ni log que lo delate. Con la fila persistida, la recuperacion mintea el mismo numero o no
-- mintea nada.
--
-- LA COLUMNA ES INMUTABLE, y por el mismo motivo que `arcade_payments.arena_type`: si el total
-- pudiera cambiarse despues de grabarse, la fila ya no seria la prueba de lo que se minteo y
-- `recoverScoreMint` volveria a depender de un recalculo. Se escribe una vez, en el INSERT que crea
-- la fila de score, y el trigger la bloquea para siempre.
--
-- LO QUE NO ESTA AQUI, Y POR QUE
--
-- No hay columna para el multiplicador ni para el instante de activacion del booster. El
-- multiplicador esta en `lib/arcade-arenas.ts` (`BoosterRules.multiplierBps`) y el instante viaja
-- dentro de `gameplay` como `boosterActivations`, que ya se persiste entero. Duplicarlos aqui
-- seria crear una segunda fuente de verdad para un numero que el registro de arenas ya gobierna, y
-- es exactamente la clase de desincronizacion que hizo que AGENT pasara de id 1 a 3 sin que nada
-- lo notara.
--
-- `vynar_points` NO participa en ninguna vista de ranking. `arcade_scores_best` y
-- `arcade_scores_ranked` filtran por `score`, y `score` es el numero sin multiplicar. Un booster no
-- puede mover un puesto en el leaderboard, y no es una convencion: es que la columna duplicada no
-- esta en la vista.

begin;

-- ── arcade_scores.vynar_points ────────────────────────────────────────────────

-- El total de VYNAR-puntos que se paso a `mintForScoreOnce`. `bigint` y no `integer`: con el 2x, el
-- tope de una partida llega a `maxEvents * (base + decay * bonus) * 2`, que en `hard` son
-- 60 * (100 + 15*15) * 2 = 28800. Cabe en `integer` de sobra hoy, pero el registro ya expresa los
-- montos en wei como `numeric(78,0)` y `bigint` evita tener que migrar el tipo el dia que
-- `maxEvents` o el multiplicador cambien.
alter table public.arcade_scores add column if not exists vynar_points bigint;

-- `>= 0` porque el VYNAR nunca es negativo. El limite superior NO se comprueba aqui con un CHECK
-- contra el registro de arenas: SQL no sabe que es `maxEvents * (base + decay*bonus) * multiplierBps`,
-- y un CHECK con ese numero metido a mano seria la segunda fuente de verdad que este fichero acaba
-- de rechazar en el parrafo de arriba. El techo lo comprueba `vynarPointsRangeError` en
-- `lib/booster-validation.ts`, que si lee el registro. Si aqui hubiera un `check (vynar_points <= 28800)`
-- y manana `hard` cambiara su bonus, la base rechazaria inserts validos y nadie recordaria por que.
alter table public.arcade_scores drop constraint if exists arcade_scores_vynar_points_nonnegative;
alter table public.arcade_scores add constraint arcade_scores_vynar_points_nonnegative check (vynar_points is null or vynar_points >= 0);

-- Que el total de VYNAR nunca sea MENOR que el score. El booster multiplica y nunca divide, asi que
-- un total por debajo del score solo puede significar que se grabaron numeros de dos partidas
-- distintas. Este es el unico invariante que si se comprueba en SQL porque no necesita el registro:
-- es una relacion entre dos columnas de la misma fila.
alter table public.arcade_scores drop constraint if exists arcade_scores_vynar_points_gte_score;
alter table public.arcade_scores add constraint arcade_scores_vynar_points_gte_score check (vynar_points is null or vynar_points >= score);

comment on column public.arcade_scores.vynar_points is
  'Exact total passed to mintForScoreOnce as `points`. Equals score when no booster was used, and score plus the boosted click values when it was. Never part of any ranking view. Immutable: recoverScoreMint re-mints this value instead of recomputing it.';

-- ORDEN: la FUNCION va antes que el TRIGGER que la usa. Postgres no valida la existencia de la
-- funcion al crear el trigger, solo al ejecutarlo, asi que el orden invertido no falla al aplicar
-- la migracion: falla la primera vez que alguien intente UPDATE. Por eso esta nota, y porque el
-- arnes de PGlite si lo detecta.
create or replace function public.reject_arcade_vynar_points_mutation()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  -- Un UPDATE que vuelve a escribir el MISMO valor no se rechaza. `before update OF columna` se
  -- dispara por mencion en la lista SET, no por cambio de valor: Postgres no lo distingue. Sin
  -- este `is not distinct from`, un `set vynar_points = vynar_points` inocuo, que hace un
  -- servicio de reconciliacion al reescribir la fila entera— reventaria con un error que no dice
  -- nada del problema real. Lo que se prohibe es cambiarlo, que es lo que el nombre del trigger
  -- promete y lo que el invariante necesita.
  if new.vynar_points is not distinct from old.vynar_points then
    return new;
  end if;
  raise exception 'VYNAR_POINTS_IMMUTABLE: %', old.vynar_points
    using errcode = '23514';
end
$fn$;

drop trigger if exists arcade_scores_vynar_points_no_update on public.arcade_scores;
create trigger arcade_scores_vynar_points_no_update before update of vynar_points on public.arcade_scores
  for each row execute function public.reject_arcade_vynar_points_mutation();

comment on trigger arcade_scores_vynar_points_no_update on public.arcade_scores is
  'Keeps arcade_scores.vynar_points immutable once written: recoverScoreMint must re-mint the same total the original attempt used, and a recomputable column would make the outcome depend on which transaction confirms first.';

-- ── arcade_booster_units ──────────────────────────────────────────────────────

-- El booster se PAGA, y el pago es lo unico que impide que el 2x salga gratis.
-- `boosterValidationError` recibe `availableUnits` y rechaza con `booster_no_units` si se declaran
-- mas activaciones de las que hay, pero ese numero tiene que salir de esta tabla y no del cuerpo de
-- la peticion: un cliente que declarase su propio saldo declararia 60 activaciones y el 2x saldria
-- gratis.
--
-- La fila se consume con un CAS (`update ... where status = 'available'`), no con un delete. Es el
-- mismo modelo de concurrencia optimista que `session-store.transitionSession`: si dos Finish
-- concurrentes intentan gastar la misma unidad, el segundo hace match de 0 filas y sabe que no la
-- tiene. Un delete no daria esa senal, porque los dos devolverian exito.
--
-- Una unidad por fila, y no un contador de saldo. Es lo que hace posible el CAS: un `balance integer`
-- que dos peticiones restan a la vez necesita mas logica para no sobregastar, y "no hay fila que
-- actualizar" es una senal de conflicto que el servidor ya sabe leer.
create table if not exists public.arcade_booster_units (
  id uuid primary key default gen_random_uuid(),
  wallet text not null,
  -- `smallint` y no `integer` por el mismo motivo que `svp_epoch_snapshots.arena`: guarda el id
  -- on-chain de `enum ArenaType` y el rango 0..3 cabe de sobra. Guardar aqui el NOMBRE en vez del
  -- id seria una segunda fuente de verdad con la que se puede desincronizar el renumerado AGENT
  -- 1 -> 3, que es la trampa que estas migraciones existen para cerrar.
  arena smallint not null check (arena between 0 and 3),
  status text not null default 'available' check (status in ('available','consumed')),
  -- La sesion que lo consumio. `null` mientras esta disponible. No es una FK a `arcade_sessions`
  -- porque el consumo ocurre DESPUES de que la sesion pase a `submitting` y en la misma transaccion
  -- logica que el INSERT de `arcade_scores`; atar el orden de las dos escrituras con una FK seria
  -- hacer que el INSERT de la score fallara por una unidad, que es al reves de como debe fallar.
  consumed_session_id text,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

create index if not exists arcade_booster_units_available_idx
  on public.arcade_booster_units(wallet, arena) where status = 'available';

alter table public.arcade_booster_units enable row level security;

-- Misma politica que las demas tablas de escritura: todas las escrituras van por el service role, y
-- un cliente anon solo recibe respuestas de API. Sin esta politica el RLS de la tabla blinda pero no
-- cierra, que es la diferencia entre "no se puede leer" y "no se puede escribir".
drop policy if exists "no direct booster unit access" on public.arcade_booster_units;
create policy "no direct booster unit access" on public.arcade_booster_units
  for all to anon, authenticated using (false) with check (false);

-- Una unidad no puede volver a estar disponible, ni cambiar de modo, ni de dueño. Se fija con un
-- trigger en vez de con la confianza en el codigo porque el codigo que consume es el unico que
-- llama, y una regla que solo existe en el unico sitio que la necesita no es una regla.
create or replace function public.reject_arcade_booster_unit_mutation()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  raise exception 'BOOSTER_UNIT_IMMUTABLE: %', old.id
    using errcode = '23514';
end
$fn$;

drop trigger if exists arcade_booster_units_no_update on public.arcade_booster_units;
create trigger arcade_booster_units_no_update before update of wallet, arena, created_at on public.arcade_booster_units
  for each row execute function public.reject_arcade_booster_unit_mutation();

-- Y una unidad consumida no puede volver a consumirse. Este es el otro lado del CAS: la funcion de
-- aplicacion filtra por `status = 'available'`, asi que sin este trigger un segundo UPDATE con el
-- filtro puesto a mano (`set status='consumed'`) pasaria y una unidad gastada dos veces pagaria un
-- 2x de mas sin que ninguna lectura lo detectara.
create or replace function public.reject_arcade_booster_unit_reconsume()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if old.status = 'consumed' then
    raise exception 'BOOSTER_UNIT_ALREADY_CONSUMED: %', old.id
      using errcode = '23514';
  end if;
  return new;
end
$fn$;

drop trigger if exists arcade_booster_units_no_reconsume on public.arcade_booster_units;
create trigger arcade_booster_units_no_reconsume before update of status on public.arcade_booster_units
  for each row execute function public.reject_arcade_booster_unit_reconsume();

comment on table public.arcade_booster_units is
  'One row per paid booster unit. Consumed with a compare-and-set on status, so two concurrent Finish calls cannot both spend the same unit.';
comment on column public.arcade_booster_units.arena is
  'On-chain ArenaType id (HUMAN 0, MEDIUM 1, HARD 2, AGENT 3). Not the mode name: a second copy of that mapping is how AGENT moved from id 1 to 3 unnoticed.';

commit;
