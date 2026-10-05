-- Audit remediation: session and score row integrity.

-- FINDING (high): app/api/play/finish/route.ts wrote `mint_tx_hash` onto arcade_sessions,
-- but no migration ever created that column (it only exists on arcade_scores). The update
-- therefore failed with Postgres 42703, the error was swallowed by the surrounding catch,
-- and the session was stranded in `submitting` while the score row had already been marked
-- recorded.
alter table public.arcade_sessions add column if not exists mint_tx_hash text unique;

comment on column public.arcade_sessions.mint_tx_hash is 'VYNAR mint transaction recovered for this session, when the score is recorded but the mint needed recovery.';

-- FINDING (medium): nothing tied status = 'recorded' to a non-null tx_hash, so a row could be
-- published on the public leaderboard and consumed by the reward engine with no on-chain proof.
-- The application always wrote both together, so this closes a latent invariant hole.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'arcade_scores_recorded_requires_tx') then
    if exists (select 1 from public.arcade_scores where status = 'recorded' and tx_hash is null) then
      raise exception 'CANNOT ADD arcade_scores_recorded_requires_tx: recorded rows without tx_hash exist. Reconcile them from chain data before re-running.';
    end if;
    alter table public.arcade_scores add constraint arcade_scores_recorded_requires_tx
      check (status <> 'recorded' or tx_hash is not null);
  end if;
end $$;

-- FINDING (medium): the state-machine trigger was BEFORE UPDATE OF status only, so an INSERT
-- could seed a session directly in a terminal state. Sessions are created in 'active'
-- (lib/session-store.ts) without passing through created/paid.
create or replace function public.arcade_session_insert_allowed()
returns trigger language plpgsql as $$
begin
  -- New sessions may only enter the non-terminal bootstrap states.
  if new.status not in ('created','paid','active') then
    raise exception 'invalid arcade session initial status: %', new.status using errcode = 'check_violation';
  end if;
  return new;
end; $$;

drop trigger if exists arcade_sessions_insert_transition on public.arcade_sessions;
create trigger arcade_sessions_insert_transition
  before insert on public.arcade_sessions
  for each row execute function public.arcade_session_insert_allowed();

-- FINDING (medium/low): every wallet column is bare text with no case or format guarantee, while
-- writes used the raw chain value (viem returns lowercase for eth_getTransactionByHash) and reads
-- filtered on lower(wallet). That split is fragile: an EIP-55 checksummed write would make a
-- player's own history and rewards silently empty. Normalise on write so both sides agree.
create or replace function public.normalize_wallet_case()
returns trigger language plpgsql as $$
begin
  new.wallet := lower(new.wallet);
  return new;
end; $$;

drop trigger if exists arcade_payments_wallet_case on public.arcade_payments;
create trigger arcade_payments_wallet_case before insert or update of wallet on public.arcade_payments
  for each row execute function public.normalize_wallet_case();

drop trigger if exists arcade_sessions_wallet_case on public.arcade_sessions;
create trigger arcade_sessions_wallet_case before insert or update of wallet on public.arcade_sessions
  for each row execute function public.normalize_wallet_case();

drop trigger if exists arcade_scores_wallet_case on public.arcade_scores;
create trigger arcade_scores_wallet_case before insert or update of wallet on public.arcade_scores
  for each row execute function public.normalize_wallet_case();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'arcade_payments_wallet_format') then
    alter table public.arcade_payments add constraint arcade_payments_wallet_format
      check (wallet ~ '^0x[0-9a-f]{40}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'arcade_sessions_wallet_format') then
    alter table public.arcade_sessions add constraint arcade_sessions_wallet_format
      check (wallet ~ '^0x[0-9a-f]{40}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'arcade_scores_wallet_format') then
    alter table public.arcade_scores add constraint arcade_scores_wallet_format
      check (wallet ~ '^0x[0-9a-f]{40}$');
  end if;
end $$;

-- FINDING (medium): the schema never constrained arcade_sessions.wallet/epoch to match its
-- payment, nor arcade_scores.wallet/epoch/arena to match its session. The application supplied
-- these correctly, but they are the identity used by the reward engine, so an off-by-one is a
-- silent payout bug. lib/session-store.ts also stored `input.epoch` rather than payment.epoch.
create or replace function public.arcade_session_matches_payment()
returns trigger language plpgsql as $$
declare
  payment_wallet text;
  payment_epoch numeric(78,0);
begin
  select p.wallet, p.epoch into payment_wallet, payment_epoch
  from public.arcade_payments p where p.id = new.payment_id;

  if not found then
    raise exception 'SESSION_PAYMENT_MISSING: %', new.payment_id using errcode = 'foreign_key_violation';
  end if;
  if payment_wallet is distinct from new.wallet then
    raise exception 'SESSION_WALLET_DOES_NOT_MATCH_PAYMENT' using errcode = 'check_violation';
  end if;
  if payment_epoch is not null and payment_epoch is distinct from new.epoch then
    raise exception 'SESSION_EPOCH_DOES_NOT_MATCH_PAYMENT' using errcode = 'check_violation';
  end if;
  return new;
end; $$;

drop trigger if exists arcade_sessions_payment_binding on public.arcade_sessions;
create trigger arcade_sessions_payment_binding
  before insert or update of payment_id, wallet, epoch on public.arcade_sessions
  for each row execute function public.arcade_session_matches_payment();

create or replace function public.arcade_score_matches_session()
returns trigger language plpgsql as $$
declare
  session_wallet text;
  session_epoch numeric(78,0);
  session_arena text;
begin
  select s.wallet, s.epoch, s.arena_type into session_wallet, session_epoch, session_arena
  from public.arcade_sessions s where s.session_id = new.session_id;

  if not found then
    raise exception 'SCORE_SESSION_MISSING: %', new.session_id using errcode = 'foreign_key_violation';
  end if;
  if session_wallet is distinct from new.wallet then
    raise exception 'SCORE_WALLET_DOES_NOT_MATCH_SESSION' using errcode = 'check_violation';
  end if;
  if session_epoch is distinct from new.epoch then
    raise exception 'SCORE_EPOCH_DOES_NOT_MATCH_SESSION' using errcode = 'check_violation';
  end if;
  if session_arena is distinct from new.arena_type then
    raise exception 'SCORE_ARENA_DOES_NOT_MATCH_SESSION' using errcode = 'check_violation';
  end if;
  return new;
end; $$;

drop trigger if exists arcade_scores_session_binding on public.arcade_scores;
create trigger arcade_scores_session_binding
  before insert or update of session_id, wallet, epoch, arena_type on public.arcade_scores
  for each row execute function public.arcade_score_matches_session();

-- FINDING (medium): arcade_payments.epoch was the only nullable epoch in the schema. A verified
-- payment with epoch IS NULL made app/api/play/route.ts evaluate BigInt(String(null)), which
-- throws a SyntaxError and permanently bricks that payment.
do $$
declare
  null_count integer;
begin
  select count(*) into null_count from public.arcade_payments where epoch is null;
  if null_count = 0 then
    alter table public.arcade_payments alter column epoch set not null;
  else
    raise exception 'CANNOT SET NOT NULL on arcade_payments.epoch: % verified payments have no epoch. Backfill epoch from chain data before re-running.', null_count;
  end if;
end $$;

-- FINDING (medium): expires_at was stored but never enforced by any constraint or trigger, so
-- expiry lived purely in application code (app/api/play/finish/route.ts). Expiry cannot be a
-- CHECK constraint because it depends on wall-clock time; a partial index at least keeps the
-- expiry scan cheap and documents that the invariant is application-enforced.
create index if not exists arcade_sessions_expiry_idx
  on public.arcade_sessions (expires_at)
  where status in ('created','paid','active');

comment on column public.arcade_sessions.expires_at is
  'Session TTL. Expiry is enforced in app/api/play/finish/route.ts; Postgres cannot express a time-dependent CHECK.';

-- FINDING (medium): the reward tables have no CHECK on the client-supplied points/amount, so
-- app/api/incentive/claim-status/route.ts could persist arbitrary strings into a financial
-- table. vyr_allocations already had range checks; vyr_claims did not.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'vyr_claims_points_nonnegative') then
    alter table public.vyr_claims add constraint vyr_claims_points_nonnegative check (points >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'vyr_claims_amount_nonnegative') then
    alter table public.vyr_claims add constraint vyr_claims_amount_nonnegative check (amount >= 0);
  end if;
end $$;

-- FINDING (low): vyr_epoch_distributions kept `status` and `published` as two independent
-- columns that public RLS keys off, so they could disagree (status='failed', published=true).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'vyr_epoch_distributions_published_matches_status') then
    alter table public.vyr_epoch_distributions add constraint vyr_epoch_distributions_published_matches_status
      check (published = false or status = 'published');
  end if;
end $$;

-- FINDING (medium): the payment_id uniqueness guarantee was added with a bare
-- `alter table ... add constraint`, which aborts the entire migration if any duplicate
-- payment_id rows already exist, with no remediation step. Make it idempotent and actionable.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'arcade_sessions_payment_id_unique') then
    if exists (select 1 from public.arcade_sessions group by payment_id having count(*) > 1) then
      raise exception 'CANNOT ADD arcade_sessions_payment_id_unique: duplicate payment_id rows exist. Dedupe them before re-running.';
    end if;
    alter table public.arcade_sessions add constraint arcade_sessions_payment_id_unique unique (payment_id);
  end if;
end $$;

-- FINDING (low): touch_updated_at and arcade_session_transition_allowed kept the default PUBLIC
-- EXECUTE grant in every migration; the revokes lived only in schema-complete.sql, which is not
-- applied. Both return trigger, so direct invocation fails anyway, but the grants were wider than
-- intended. Unlike the other trigger functions, these were never revoked in a migration.
revoke all on function public.touch_updated_at() from public;
revoke all on function public.arcade_session_transition_allowed() from public;
revoke all on function public.arcade_session_insert_allowed() from public;
revoke all on function public.normalize_wallet_case() from public;
revoke all on function public.arcade_session_matches_payment() from public;
revoke all on function public.arcade_score_matches_session() from public;

grant execute on function public.touch_updated_at() to service_role;
grant execute on function public.arcade_session_transition_allowed() to service_role;
grant execute on function public.arcade_session_insert_allowed() to service_role;
grant execute on function public.normalize_wallet_case() to service_role;
grant execute on function public.arcade_session_matches_payment() to service_role;
grant execute on function public.arcade_score_matches_session() to service_role;