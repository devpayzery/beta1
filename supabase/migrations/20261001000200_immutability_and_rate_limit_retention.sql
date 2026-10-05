-- Audit remediation: immutability of financial records, privilege hardening, rate-limit retention.

-- FINDING (medium): every "this record is immutable" guarantee was a BEFORE UPDATE trigger, so
-- DELETE was entirely unblocked. Deleting a published svp_epoch_snapshot silently cascades and
-- wipes every svp_reward_allocations row (ON DELETE CASCADE), destroying the financial audit
-- trail. Anything holding service_role could do it.
create or replace function public.reject_delete_of_immutable_record()
returns trigger language plpgsql as $$
begin
  raise exception '% records are immutable and cannot be deleted', tg_table_name using errcode = 'integrity_constraint_violation';
end; $$;

drop trigger if exists svp_epoch_snapshot_no_delete on public.svp_epoch_snapshots;
create trigger svp_epoch_snapshot_no_delete before delete on public.svp_epoch_snapshots
  for each row execute function public.reject_delete_of_immutable_record();

drop trigger if exists vyr_epoch_distribution_no_delete on public.vyr_epoch_distributions;
create trigger vyr_epoch_distribution_no_delete before delete on public.vyr_epoch_distributions
  for each row execute function public.reject_delete_of_immutable_record();

drop trigger if exists vyr_chain_snapshot_no_delete on public.vyr_chain_snapshots;
create trigger vyr_chain_snapshot_no_delete before delete on public.vyr_chain_snapshots
  for each row execute function public.reject_delete_of_immutable_record();

-- svp_reward_allocations only becomes immutable once its snapshot is published; unclaimed rows of
-- a pending snapshot may still be corrected, so mirror the existing UPDATE trigger's condition.
--
-- NOTE: this function reads old.snapshot_id, which only exists on svp_reward_allocations. It must
-- NOT be attached to vyr_allocations: plpgsql resolves old.<field> at runtime, so a DELETE there
-- would raise "record old has no field snapshot_id" regardless of publish state -- blocking every
-- delete instead of only published ones. vyr_allocations gets its own function below.
create or replace function public.reject_delete_of_published_allocation()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from public.svp_epoch_snapshots s
    where s.id = old.snapshot_id and s.status = 'snapshotted'
  ) then
    raise exception 'published svp_reward_allocations rows cannot be deleted' using errcode = 'integrity_constraint_violation';
  end if;
  return old;
end; $$;

drop trigger if exists svp_reward_allocation_no_delete on public.svp_reward_allocations;
create trigger svp_reward_allocation_no_delete before delete on public.svp_reward_allocations
  for each row execute function public.reject_delete_of_published_allocation();

create or replace function public.reject_delete_of_published_vyr_allocation()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from public.vyr_epoch_distributions d
    where d.epoch = old.epoch and d.arena_type = old.arena_type and d.published
  ) then
    raise exception 'published vyr_allocations rows cannot be deleted' using errcode = 'integrity_constraint_violation';
  end if;
  return old;
end; $$;

drop trigger if exists vyr_allocation_no_delete on public.vyr_allocations;
create trigger vyr_allocation_no_delete before delete on public.vyr_allocations
  for each row execute function public.reject_delete_of_published_vyr_allocation();

-- arcade_payments / arcade_sessions / arcade_scores form the audit trail behind every on-chain
-- score and prize. Prevent silent destruction the same way.
drop trigger if exists arcade_payments_no_delete on public.arcade_payments;
create trigger arcade_payments_no_delete before delete on public.arcade_payments
  for each row execute function public.reject_delete_of_immutable_record();

drop trigger if exists arcade_sessions_no_delete on public.arcade_sessions;
create trigger arcade_sessions_no_delete before delete on public.arcade_sessions
  for each row execute function public.reject_delete_of_immutable_record();

drop trigger if exists arcade_scores_no_delete on public.arcade_scores;
create trigger arcade_scores_no_delete before delete on public.arcade_scores
  for each row execute function public.reject_delete_of_immutable_record();

-- FINDING (medium): cross-table claim-tx exclusivity between vyr_claims.tx_hash and
-- svp_reward_allocations.claim_tx_hash was enforced only by a racy BEFORE trigger: two concurrent
-- transactions each hold an uncommitted row the other cannot see, both pass the EXISTS check, and
-- both commit. The per-table unique constraints cannot help because they live in different tables.
-- Serialise on an advisory lock keyed by the tx hash so the check-then-act becomes atomic.
create or replace function public.reject_claim_tx_reuse()
returns trigger language plpgsql as $$
begin
  if new.tx_hash is not null then
    -- Transaction-scoped lock: released automatically at COMMIT/ROLLBACK, so it cannot leak.
    perform pg_advisory_xact_lock(hashtext('claim_tx:' || new.tx_hash));
    if exists (select 1 from public.vyr_claims c where c.tx_hash = new.tx_hash and c.id <> new.id) then
      raise exception 'CLAIM_TX_ALREADY_ASSOCIATED' using errcode = 'unique_violation';
    end if;
    if exists (select 1 from public.svp_reward_allocations a where a.claim_tx_hash = new.tx_hash and a.id <> new.id) then
      raise exception 'CLAIM_TX_ALREADY_ASSOCIATED' using errcode = 'unique_violation';
    end if;
  end if;
  return new;
end; $$;

create or replace function public.reject_svp_claim_tx_reuse()
returns trigger language plpgsql as $$
begin
  if new.claim_tx_hash is not null then
    perform pg_advisory_xact_lock(hashtext('claim_tx:' || new.claim_tx_hash));
    if exists (select 1 from public.vyr_claims c where c.tx_hash = new.claim_tx_hash) then
      raise exception 'CLAIM_TX_ALREADY_ASSOCIATED' using errcode = 'unique_violation';
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists vyr_claim_tx_reuse on public.vyr_claims;
create trigger vyr_claim_tx_reuse before insert or update of tx_hash on public.vyr_claims
  for each row execute function public.reject_claim_tx_reuse();

drop trigger if exists svp_claim_tx_reuse on public.svp_reward_allocations;
create trigger svp_claim_tx_reuse before insert or update of claim_tx_hash on public.svp_reward_allocations
  for each row execute function public.reject_svp_claim_tx_reuse();

-- FINDING (medium): the two svp_* policies were created without `to anon, authenticated` (so they
-- defaulted to PUBLIC) and without a drop-if-exists, making the migration non-idempotent. They
-- also never revoked table privileges, so anon held INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER
-- with RLS as the only barrier, unlike every other table in the schema.
drop policy if exists "published svp snapshots are readable" on public.svp_epoch_snapshots;
drop policy if exists "svp allocations are readable" on public.svp_reward_allocations;

create policy "published svp snapshots are readable" on public.svp_epoch_snapshots
  for select to anon, authenticated using (status = 'snapshotted');

create policy "svp allocations are readable" on public.svp_reward_allocations
  for select to anon, authenticated using (
    exists (select 1 from public.svp_epoch_snapshots s where s.id = snapshot_id and s.status = 'snapshotted')
  );

revoke all on public.svp_epoch_snapshots from anon, authenticated;
revoke all on public.svp_reward_allocations from anon, authenticated;
grant select on public.svp_epoch_snapshots to anon, authenticated;
grant select on public.svp_reward_allocations to anon, authenticated;

-- FINDING (low): RLS was enabled but never FORCEd, so a table owner bypasses it. service_role has
-- BYPASSRLS and is unaffected; forcing RLS closes the gap for any future non-BYPASSRLS owner.
--
-- IMPORTANT DEPENDENCY: arcade_scores_ranked / arcade_scores_best / arcade_leaderboard_public (added in
-- 20261001000000_score_ranking_and_public_surface.sql) deliberately omit security_invoker so that anon
-- can read them without a grant on the base table. That makes them execute with the *view owner's*
-- privileges. FORCE ROW LEVEL SECURITY here applies policies to the table owner, so those views return
-- rows only because the view owner is a BYPASSRLS role (postgres in Supabase). If these views are ever
-- recreated under a non-BYPASSRLS owner, they will silently return zero rows rather than error --
-- deny-all policies turn a privilege mistake into an empty leaderboard. Diagnose with:
--   select rolname, rolbypassrls, rolsuper from pg_roles where rolname = current_user;
alter table public.arcade_payments force row level security;
alter table public.arcade_sessions force row level security;
alter table public.arcade_scores force row level security;
alter table public.arcade_rate_limits force row level security;
alter table public.vyr_epoch_distributions force row level security;
alter table public.vyr_allocations force row level security;
alter table public.vyr_claims force row level security;
alter table public.vyr_chain_snapshots force row level security;
alter table public.svp_epoch_snapshots force row level security;
alter table public.svp_reward_allocations force row level security;

-- FINDING (high): arcade_rate_limits was never purged. No DELETE, TTL job, pg_cron schedule or
-- retention function targeted it anywhere in the repo, so growth was bounded only by the number of
-- distinct subjects ever observed. This is especially costly because a client that can vary its
-- apparent IP mints a fresh row per request.
--
-- Purge buckets whose window has fully elapsed. Safe because a bucket that has expired starts
-- over from count = 1 on the next request (see consume_arcade_rate_limit's ON CONFLICT clause).
create or replace function public.purge_expired_arcade_rate_limits(
  p_max_age_seconds integer default 3600
)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  removed integer;
begin
  if p_max_age_seconds < 60 then
    raise exception 'p_max_age_seconds must be at least 60';
  end if;
  delete from public.arcade_rate_limits
  where window_started_at < clock_timestamp() - make_interval(secs => p_max_age_seconds);
  get diagnostics removed = row_count;
  return removed;
end; $$;

revoke all on function public.purge_expired_arcade_rate_limits(integer) from public, anon, authenticated;
grant execute on function public.purge_expired_arcade_rate_limits(integer) to service_role;

comment on function public.purge_expired_arcade_rate_limits is
  'Deletes rate-limit buckets whose window elapsed more than p_max_age_seconds ago. Call from the cron worker or pg_cron.';

-- Schedule the purge when pg_cron is available (Supabase enables it by default). Guarded so the
-- migration still succeeds on instances where the extension is not installed.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema extensions;
    if not exists (select 1 from cron.job where jobname = 'purge-arcade-rate-limits') then
      -- The command carries its own dollar-quote tag. Reusing the plain tag would close
      -- the enclosing DO block instead of opening a string, leaving Postgres to parse the
      -- command as the start of a new statement and fail with "syntax error at or near
      -- select". Found by applying this chain against a real Postgres; the migration had
      -- never been executed anywhere, so nothing had caught it.
      --
      -- Note for future editors: do not write a bare double-dollar sequence inside these
      -- comments. It closes the enclosing dollar-quoted block wherever it appears, comment
      -- or not, and the error points at the next statement rather than at the comment.
      perform cron.schedule('purge-arcade-rate-limits', '*/10 * * * *',
        $cron$select public.purge_expired_arcade_rate_limits(3600)$cron$);
    end if;
  end if;
end $$;

-- FINDING (medium): the svp_* policies referenced a snapshot row by id only; the tables also carry
-- denormalised epoch/arena columns that nothing constrains to equal the snapshot's values.
create or replace function public.svp_allocation_matches_snapshot()
returns trigger language plpgsql as $$
declare
  snapshot_epoch bigint;
  snapshot_arena smallint;
begin
  select s.epoch, s.arena into snapshot_epoch, snapshot_arena
  from public.svp_epoch_snapshots s where s.id = new.snapshot_id;

  if not found then
    raise exception 'SVP_ALLOCATION_SNAPSHOT_MISSING' using errcode = 'foreign_key_violation';
  end if;
  if snapshot_epoch is distinct from new.epoch or snapshot_arena is distinct from new.arena then
    raise exception 'SVP_ALLOCATION_DOES_NOT_MATCH_SNAPSHOT' using errcode = 'check_violation';
  end if;
  return new;
end; $$;

drop trigger if exists svp_allocation_snapshot_binding on public.svp_reward_allocations;
create trigger svp_allocation_snapshot_binding
  before insert or update of snapshot_id, epoch, arena on public.svp_reward_allocations
  for each row execute function public.svp_allocation_matches_snapshot();

revoke all on function public.reject_delete_of_immutable_record() from public;
revoke all on function public.reject_delete_of_published_allocation() from public;
revoke all on function public.reject_delete_of_published_vyr_allocation() from public;
revoke all on function public.reject_claim_tx_reuse() from public;
revoke all on function public.reject_svp_claim_tx_reuse() from public;
revoke all on function public.svp_allocation_matches_snapshot() from public;