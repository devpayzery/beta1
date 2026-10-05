-- V6 arenas: widen `arena_type` from {human, agent} to {human, medium, hard, agent}.
--
-- WHY THIS IS THE MIGRATION MOST LIKELY TO BE SKIPPED
--
-- The database stores `arena_type` as TEXT, so existing rows survive untouched and no data
-- backfill is needed. The damage is entirely in the CHECK constraint: `20260921000000` added
-- `check (arena_type in ('human','agent'))`, so the very first insert of a MEDIUM or HARD
-- session is rejected by Postgres. Everything looks fine until a player pays 0.5 SVP and the
-- request fails at the database, after the payment already landed on-chain.
--
-- ON-CHAIN ID CHANGE, WHICH THIS MIGRATION DOES *NOT* AFFECT
--
-- ArcadeVaultV6 changes the enum from {HUMAN, AGENT} to {HUMAN, MEDIUM, HARD, AGENT}, so the
-- numeric id of AGENT moves from 1 to 3. That mapping lives in `lib/arcade-arenas.ts` (ARENA_IDS)
-- and is not stored here. Rows whose `arena_type = 'agent'` are still `agent` after this
-- migration; only the on-chain id they map to changes.
--
-- All objects are created inside the migration transaction, so the drop/add pair is atomic and
-- there is no window in which the table has no constraint at all.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Fail loudly on data that the new constraint would reject.
--    A silently-dropped row is worse than a failed migration: the row would stop
--    appearing in the leaderboard with no trace of why.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  offender text;
begin
  select coalesce(string_agg(distinct bad.arena_type, ', '), '')
    into offender
  from (
    select arena_type from public.arcade_sessions
    union all
    select arena_type from public.arcade_scores
    union all
    select arena_type from public.vyr_epoch_distributions
    union all
    select arena_type from public.vyr_allocations
    union all
    select arena_type from public.vyr_claims
  ) as bad
  where bad.arena_type is not null
    and bad.arena_type not in ('human', 'medium', 'hard', 'agent');

  if offender <> '' then
    raise exception
      'arena_type holds values outside {human,medium,hard,agent}: %', offender;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Widen the two existing constraints.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.arcade_sessions
  drop constraint if exists arcade_sessions_arena_type_check;
alter table public.arcade_sessions
  add constraint arcade_sessions_arena_type_check
  check (arena_type in ('human', 'medium', 'hard', 'agent'));

alter table public.arcade_scores
  drop constraint if exists arcade_scores_arena_type_check;
alter table public.arcade_scores
  add constraint arcade_scores_arena_type_check
  check (arena_type in ('human', 'medium', 'hard', 'agent'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Close the gap on the VYR tables.
--
-- These three declare `arena_type text not null default 'human'` with NO check. They were
-- only ever written from `arcade_scores`, so it never showed. Once MEDIUM and HARD exist,
-- a typo in a single publisher or cron would write 'meduim' straight into the reward
-- tables and nothing downstream would object. Adding the constraint here is the difference
-- between a typo failing at the boundary and a payout that silently never matches.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'vyr_epoch_distributions',
    'vyr_allocations',
    'vyr_claims'
  ] loop
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_arena_type_check');
    execute format(
      'alter table public.%I add constraint %I check (arena_type in (''human'', ''medium'', ''hard'', ''agent''))',
      t, t || '_arena_type_check'
    );
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The SMALLINT arena columns: a data migration, not just a constraint.
--
-- svp_epoch_snapshots.arena, svp_reward_allocations.arena and vyr_chain_snapshots.arena store
-- the raw on-chain id as smallint, and unlike the five text columns above they are NOT immune
-- to the AGENT 1 -> 3 renumber. Anything already stored as 1 was written under V5, where 1
-- meant AGENT; under V6 it silently becomes MEDIUM. Every reward snapshot, every allocation
-- and every VYNAR reconciliation row is affected, and the symptom is a leaderboard that
-- shows the right numbers attributed to the wrong arena.
--
-- The rows are renumbered 1 -> 3 before the range constraint is added. Order matters: doing
-- it the other way round would fail the new check on rows that are about to be migrated.
--
-- `unique (epoch, arena)` exists on all three tables, so a 1 -> 3 rewrite could collide with
-- an existing row in the target arena. That is loud, not silent: the migration aborts rather
-- than dropping or overwriting a reward record, which is the correct outcome because the
-- operator has to look at it.
--
-- THE TRIGGERS MUST BE SUSPENDED FIRST. reject_chain_snapshot_mutation() raises
-- CHAIN_SNAPSHOT_IMMUTABLE on any UPDATE that touches `arena`, which is exactly the change
-- being made here. That trigger is a deliberate immutability guarantee and it is not being
-- weakened: it is dropped and immediately recreated inside this transaction, so from the
-- outside it never stops existing, and an UPDATE to these rows still fails for every other
-- caller. Recreating rather than leaving it off is the whole point -- if this migration
-- aborted halfway with the trigger missing, the table would silently be mutable.
-- ─────────────────────────────────────────────────────────────────────────────
drop trigger if exists svp_epoch_snapshot_immutable on public.svp_epoch_snapshots;
drop trigger if exists vyr_chain_snapshot_immutable on public.vyr_chain_snapshots;

update public.svp_epoch_snapshots set arena = 3 where arena = 1;
update public.svp_reward_allocations set arena = 3 where arena = 1;
update public.vyr_chain_snapshots set arena = 3 where arena = 1;

create trigger svp_epoch_snapshot_immutable
  before update on public.svp_epoch_snapshots
  for each row execute function public.reject_chain_snapshot_mutation();
create trigger vyr_chain_snapshot_immutable
  before update on public.vyr_chain_snapshots
  for each row execute function public.reject_chain_snapshot_mutation();

do $$
declare
  t text;
begin
  foreach t in array array[
    'svp_epoch_snapshots',
    'svp_reward_allocations',
    'vyr_chain_snapshots'
  ] loop
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_arena_range_check');
    execute format(
      'alter table public.%I add constraint %I check (arena between 0 and 3)', t, t || '_arena_range_check'
    );
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Indexes.
--
-- The existing indexes are already (arena_type, epoch, ...) and leading with arena_type, so
-- they keep serving per-arena queries unchanged. No new index is needed for four values: at
-- this cardinality a four-way split stays far below the threshold where a composite index
-- stops being selective. The one query that would suffer is the cross-arena weekly
-- aggregate, which reads `arcade_scores_best` ordered by epoch first, and that uses the
-- ranking index's existing (epoch, arena_type) side.
-- ─────────────────────────────────────────────────────────────────────────────

comment on column public.svp_epoch_snapshots.arena is
  'Raw on-chain ArcadeVaultV6 ArenaType id: human=0, medium=1, hard=2, agent=3. Rows written under V5 with arena=1 (AGENT) were renumbered to 3 by 20261002000000.';
comment on column public.svp_reward_allocations.arena is
  'Raw on-chain ArcadeVaultV6 ArenaType id: human=0, medium=1, hard=2, agent=3. Rows written under V5 with arena=1 (AGENT) were renumbered to 3 by 20261002000000.';
comment on column public.vyr_chain_snapshots.arena is
  'Raw on-chain ArcadeVaultV6 ArenaType id: human=0, medium=1, hard=2, agent=3. Rows written under V5 with arena=1 (AGENT) were renumbered to 3 by 20261002000000.';

comment on column public.arcade_sessions.arena_type is
  'Arena selected for the session; historical rows default to human. Maps to ArcadeVaultV6 ArenaType: human=0, medium=1, hard=2, agent=3.';
comment on column public.arcade_scores.arena_type is
  'Arena used by the on-chain score submission; historical rows default to human. Maps to ArcadeVaultV6 ArenaType: human=0, medium=1, hard=2, agent=3.';
comment on column public.vyr_epoch_distributions.arena_type is
  'Arena the distribution belongs to. Maps to ArcadeVaultV6 ArenaType: human=0, medium=1, hard=2, agent=3.';
comment on column public.vyr_allocations.arena_type is
  'Arena the allocation belongs to. Maps to ArcadeVaultV6 ArenaType: human=0, medium=1, hard=2, agent=3.';
comment on column public.vyr_claims.arena_type is
  'Arena the claim belongs to. Maps to ArcadeVaultV6 ArenaType: human=0, medium=1, hard=2, agent=3.';

-- Constraints added via ALTER TABLE ... ADD CHECK are validated immediately; this is a no-op
-- kept explicit so a reader can see the tables are scanned before the migration is considered
-- done. Both tables are small (scores per epoch, capped by max_entries).
alter table public.arcade_sessions validate constraint arcade_sessions_arena_type_check;
alter table public.arcade_scores validate constraint arcade_scores_arena_type_check;
alter table public.vyr_epoch_distributions validate constraint vyr_epoch_distributions_arena_type_check;
alter table public.vyr_allocations validate constraint vyr_allocations_arena_type_check;
alter table public.vyr_claims validate constraint vyr_claims_arena_type_check;

-- `agent` stays intentionally inactive on-chain. It is retained in the constraint because the
-- column already contains it; MEDIUM and HARD must not be activated with `setArenaActive`
-- until the app can actually play them, or the vault would accept payments for modes that
-- have no gameplay.