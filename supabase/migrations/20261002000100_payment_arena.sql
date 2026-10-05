-- arcade_payments.arena_type
--
-- POR QUE ESTA MIGRACION HACE FALTA
--
-- arcade_payments registra cada `payToPlay` verificado, pero hasta ahora sin modo. Con un solo
-- modo (human a 0.1 SVP) eso no importaba. Con tres modos a 0.1 / 0.5 / 1.0 SVP, la fila deja de
-- poder explicar de donde salio el dinero: un pago de 1.0 SVP y uno de 0.1 SVP tienen la misma
-- forma, y `amount_wei` es lo unico que los distingue sin embargo una mirada al historial de pagos.
--
-- Sin esta columna, un pago de HARD que acaba mirando a una sesion de HUMAN no deja ni un
-- rastro en la tabla de pagos que permita detectarlo despues. La sesion si lleva `arena_type`
-- (y el trigger SCORE_ARENA_DOES_NOT_MATCH_SESSION ya protege el score), pero el pago es lo que
-- ocurre ANTES que la sesion exista, y es el punto donde se decide el modo.
--
-- BACKFILL
--
-- Todas las filas existentes son 'human' por construccion: hasta ArcadeVaultV6 solo habia una
-- arena en uso. El renumerado AGENT 1 -> 3 que hace 20261002000000 no aplica aqui porque esta
-- columna guarda TEXTO, no el id numerico on-chain.

begin;

-- 1) Columna. NOT NULL desde el principio, con default, para que ninguna escritura posterior
--    pueda dejarla en null.
alter table public.arcade_payments
  add column if not exists arena_type text not null default 'human';

-- 2) Backfill explicito de las filas que existieran antes del default (por ejemplo si la
--    columna se hubiera anadido nullable en otro entorno).
update public.arcade_payments set arena_type = 'human' where arena_type is null;

-- 3) Mismo conjunto de valores que las otras cinco tablas de arena. Sin este constraint, esta
--    tabla aceptaria 'meduim' y el pago quedaria registrado con un modo que no existe.
do $$
declare
  t text;
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.arcade_payments'::regclass
      and conname = 'arcade_payments_arena_type_check'
  ) then
    return;
  end if;
  alter table public.arcade_payments
    add constraint arcade_payments_arena_type_check
    check (arena_type in ('human', 'medium', 'hard', 'agent'));
end
$$;

-- 4) Indice para el cierre de epoch, que necesita "los pagos de este wallet en esta arena y
--    epoch" para reproducir la foto de la epoch. Sin el, el indice arcade_payments_epoch_idx
--    existente filtra por (wallet, epoch) y descarta la arena, con lo que cerraria una epoch
--    cruzando modos.
create index if not exists arcade_payments_arena_epoch_idx
  on public.arcade_payments (arena_type, epoch);

comment on column public.arcade_payments.arena_type is
  'Mode the payment bought. human/medium/hard/agent. Added in 20261002000100; all pre-existing rows are human because V5 had a single arena.';

-- 5) Trigger: la sesion no puede cambiar de modo respecto al pago que la compro.
--
-- 20261001000100 ya instalo SCORE_ARENA_DOES_NOT_MATCH_SESSION para atar score y sesion. Faltaba
-- el eslabon anterior. Sin el, un bug en la ruta que crea la sesion (o un service-role mal
-- usado) podria abrir una sesion de HARD pagada con el importe de HUMAN, y como el score se
-- valida contra la SESION, todo el encadenamiento pareceria correcto: el score firmaria para
-- HARD y el premio se repartiria a 1.0 SVP por una entrada de 0.1 SVP.
create or replace function public.enforce_session_arena_matches_payment()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  payment_arena text;
begin
  select p.arena_type into payment_arena
  from public.arcade_payments p
  where p.id = new.payment_id;

  if payment_arena is null then
    raise exception 'SESSION_PAYMENT_MISSING: %', new.payment_id
      using errcode = '23503';
  end if;

  if payment_arena <> new.arena_type then
    raise exception 'SESSION_ARENA_DOES_NOT_MATCH_PAYMENT: session=% payment=%',
      new.arena_type, payment_arena
      using errcode = '23514';
  end if;
  return new;
end
$fn$;

drop trigger if exists arcade_sessions_arena_matches_payment on public.arcade_sessions;
create trigger arcade_sessions_arena_matches_payment
  before insert or update of arena_type, payment_id on public.arcade_sessions
  for each row execute function public.enforce_session_arena_matches_payment();

comment on trigger arcade_sessions_arena_matches_payment on public.arcade_sessions is
  'A session may only exist for the mode its payment actually bought.';

-- 6) El modo del pago tampoco se puede retocar despues.
--
-- arcade_payments es la raiz de la cadena de custodia (pago -> sesion -> score) y ya era
-- inmutable en cuanto a borrado. Ahora su `arena_type` tambien lo es: un pago compra un modo, y
-- cambiarlo invalidaria el trigger anterior sin que ninguna otra senal lo indicara.
--
-- ORDEN: la FUNCION va antes que el TRIGGER que la usa. Postgres no valida la existencia de la
-- funcion al crear el trigger, solo al ejecutarlo, asi que el orden invertido no falla al aplicar
-- la migracion: falla la primera vez que alguien intente UPDATE sobre la columna. Por eso esta
-- nota, y porque el arnes de PGlite si lo detecta.
create or replace function public.reject_arcade_payment_arena_mutation()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  raise exception 'PAYMENT_ARENA_IMMUTABLE: %', old.arena_type
    using errcode = '23514';
end
$fn$;

drop trigger if exists arcade_payments_arena_no_update on public.arcade_payments;
create trigger arcade_payments_arena_no_update before update of arena_type on public.arcade_payments
  for each row execute function public.reject_arcade_payment_arena_mutation();

comment on trigger arcade_payments_arena_no_update on public.arcade_payments is
  'Keeps arcade_payments.arena_type immutable: a payment buys one mode, and changing it would invalidate arcade_sessions_arena_matches_payment without any other signal.';

commit;