-- Audit remediation: wallet-provenance for the per-wallet read endpoints, plus lossless
-- numeric projections.

-- FINDING (critical): /api/history, /api/incentive/my-rewards, /api/incentive/rewards and
-- /api/incentive/claim-status all took a self-asserted `?wallet=` parameter and read through the
-- service-role client, which has BYPASSRLS. Anyone could read (and on claim-status, write) another
-- address's reward and claim state by changing one query parameter.
--
-- The fix is to require proof of key ownership before any wallet-scoped read: a single-use nonce,
-- an EIP-191 signature over it, and an httpOnly session cookie scoped to the wallet that signed.
-- These tables store only the challenge lifecycle; no signature or private-key material is kept.
create table if not exists public.arcade_auth_challenges (
  wallet text not null check (wallet ~ '^0x[0-9a-f]{40}$'),
  nonce text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (wallet, nonce)
);

comment on table public.arcade_auth_challenges is
  'Single-use SIWE-style challenge nonces. Retained only until expiry so a signature can be verified.';

create index if not exists arcade_auth_challenges_expiry_idx
  on public.arcade_auth_challenges (expires_at);

alter table public.arcade_auth_challenges enable row level security;
alter table public.arcade_auth_challenges force row level security;
revoke all on public.arcade_auth_challenges from anon, authenticated;

-- Consume a nonce atomically. The UPDATE ... WHERE consumed_at IS NULL is the single-use guarantee:
-- a second concurrent attempt to redeem the same nonce matches zero rows and is rejected, so a
-- captured signature cannot be replayed.
create or replace function public.consume_arcade_auth_challenge(p_wallet text, p_nonce text)
returns boolean
language sql security definer set search_path = public, pg_temp as $$
  with claimed as (
    update public.arcade_auth_challenges
    set consumed_at = clock_timestamp()
    where wallet = p_wallet
      and nonce = p_nonce
      and consumed_at is null
      and expires_at > clock_timestamp()
    returning wallet
  )
  select exists (select 1 from claimed);
$$;

revoke all on function public.consume_arcade_auth_challenge(text, text) from public, anon, authenticated;
grant execute on function public.consume_arcade_auth_challenge(text, text) to service_role;

-- Do not keep challenges around longer than they can be used.
create or replace function public.purge_arcade_auth_challenges()
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  removed integer;
begin
  delete from public.arcade_auth_challenges where expires_at < clock_timestamp() - interval '1 hour';
  get diagnostics removed = row_count;
  return removed;
end; $$;

revoke all on function public.purge_arcade_auth_challenges() from public, anon, authenticated;
grant execute on function public.purge_arcade_auth_challenges() to service_role;

-- The challenge log is append-only per sign-in, so without a scheduled purge it grows without bound
-- (the same unbounded-growth defect the rate-limit counter table had). Scheduled on the same
-- */5 cadence as the rate-limit purge, guarded by pg_available_extensions so the migration still
-- applies on a project without pg_cron.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'purge-arcade-auth-challenges') then
      perform cron.unschedule('purge-arcade-auth-challenges');
    end if;
    -- Own dollar-quote tag, for the reason documented in
    -- 20261001000200_immutability_and_rate_limit_retention.sql: a bare double-dollar sequence
    -- here would close the enclosing DO block instead of opening a string.
    perform cron.schedule('purge-arcade-auth-challenges', '*/5 * * * *',
      $cron$select public.purge_arcade_auth_challenges()$cron$);
  end if;
end $$;

-- FINDING (medium): prize_pool, reward_amount, amount and points are numeric(78,0). PostgREST
-- serialises numeric to a JSON *number*, so any value above 2^53 is silently rounded by the JSON
-- parser before the application ever sees it. For wei-denominated amounts that is a real precision
-- loss in a financial field. Casting to text in a view makes PostgREST emit a JSON string, which
-- JavaScript parses losslessly; the routes already stringify these values.
create or replace view public.svp_reward_allocations_wei as
select id, snapshot_id, epoch, arena, rank, wallet,
       prize_pool::text as prize_pool,
       reward_amount::text as reward_amount,
       claimed, claim_tx_hash, submitted_at, confirmed_at, created_at
from public.svp_reward_allocations;

comment on view public.svp_reward_allocations_wei is
  'svp_reward_allocations with numeric(78,0) amounts cast to text, so PostgREST returns JSON strings instead of lossy numbers.';

create or replace view public.vyr_claims_wei as
select id, epoch, arena_type, wallet,
       points::text as points,
       amount::text as amount,
       status, tx_hash, submitted_at, confirmed_at, failed_at, error_code, created_at
from public.vyr_claims;

comment on view public.vyr_claims_wei is
  'vyr_claims with numeric(78,0) values cast to text to avoid JSON number precision loss.';

-- vyr_chain_snapshots has no confirmed_at column; its terminal timestamp is updated_at, which the
-- touch_updated_at trigger advances on every write.
create or replace view public.vyr_chain_snapshots_wei as
select id, epoch, arena, prize_pool::text as prize_pool, top10, status, reconciliation_status, created_at, updated_at
from public.vyr_chain_snapshots;

comment on view public.vyr_chain_snapshots_wei is
  'vyr_chain_snapshots with numeric(78,0) prize_pool cast to text to avoid JSON number precision loss.';

-- All three views are read exclusively through the service-role client (lib/supabase/admin.ts), which
-- bypasses RLS by design. anon is deliberately NOT granted select on any of them: these are reward and
-- prize amounts, and a direct PostgREST grant would let a caller bypass the route-level rate limiting
-- on /api/incentive/{epochs,rewards,claim-status} entirely. Unlike arcade_leaderboard_public, none of
-- this data is public.
revoke all on public.svp_reward_allocations_wei from anon, authenticated;
revoke all on public.vyr_claims_wei from anon, authenticated;
revoke all on public.vyr_chain_snapshots_wei from anon, authenticated;
revoke all on public.arcade_auth_challenges from anon, authenticated;

-- service_role is the only intended reader of these, but BYPASSRLS does not imply table privileges,
-- so the grant is stated explicitly rather than assumed from platform `alter default privileges`.
grant select on public.svp_reward_allocations_wei to service_role;
grant select on public.vyr_claims_wei to service_role;
grant select on public.vyr_chain_snapshots_wei to service_role;
grant select, insert, update, delete on public.arcade_auth_challenges to service_role;
grant usage on schema public to service_role;