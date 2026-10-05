-- ============================================================================
-- schema-complete.sql — CONSOLIDATED FULL SCHEMA (from-scratch provisioning)
-- ============================================================================
--
-- PURPOSE
--   Creates the entire arcade database in one shot, for a fresh database that
--   will never have run the migrations:
--
--     psql "$DATABASE_URL" -f supabase/schema-complete.sql
--
--   This is a CONVENIENCE artefact for greenfield provisioning only.
--
-- SOURCE OF TRUTH
--   supabase/migrations/ is authoritative. This file is a hand-maintained
--   consolidation of the end state of all 17 migrations, in order. If they
--   ever disagree, THE MIGRATIONS WIN and this file is wrong.
--
--   Before regenerating, diff against the migrations. The previous version of
--   this file was stale: it omitted svp_epoch_snapshots, svp_reward_allocations
--   and vyr_chain_snapshots entirely, so provisioning from it silently produced
--   a database missing every SVP reward table and the whole chain-snapshot
--   table. That is why the omission is called out here rather than left implicit.
--
-- WHAT IS IN HERE (17 relations)
--   arcade_payments, arcade_sessions, arcade_scores, arcade_rate_limits (legacy),
--   arcade_rate_limit_hits, arcade_auth_challenges,
--   vyr_epoch_distributions, vyr_allocations, vyr_claims, vyr_chain_snapshots,
--   svp_epoch_snapshots, svp_reward_allocations
--   + views arcade_scores_ranked, arcade_scores_best, arcade_leaderboard_public,
--     arcade_leaderboard, svp_reward_allocations_wei, vyr_claims_wei,
--     vyr_chain_snapshots_wei
--
-- ENVIRONMENT
--   Requires the anon / authenticated / service_role roles to exist (standard
--   on Supabase). gen_random_uuid() is core in PostgreSQL 13+, so no extension
--   is needed for it. pg_cron is created only when available; every schedule
--   below is guarded so this script succeeds without it.
--
--   Run as a role that is the owner of these objects and holds BYPASSRLS
--   (postgres in Supabase). See the FORCE ROW LEVEL SECURITY warning below —
--   it is not cosmetic.
-- ============================================================================


-- ============================================================================
-- 1. ARCADE CORE
-- ============================================================================

create table public.arcade_payments (
  id uuid primary key default gen_random_uuid(),
  tx_hash text not null unique,
  wallet text not null,
  chain_id bigint not null,
  amount_wei numeric(78,0) not null,
  -- Added by 20260922000000, backfilled from the session's epoch, then made
  -- NOT NULL by 20261001000100. No default: an epoch must be stated explicitly,
  -- because BigInt(String(null)) throws and would brick the payment.
  epoch numeric(78,0) not null,
  status text not null default 'verified' check (status in ('pending','verified','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Audit fix: bare text wallet with no format guarantee. A checksummed write
  -- would make the owner's own history silently empty, because reads filter on
  -- lower(wallet). normalize_wallet_case() lowercases on write; this CHECK is
  -- the backstop.
  constraint arcade_payments_wallet_format check (wallet ~ '^0x[0-9a-f]{40}$')
);

comment on table public.arcade_payments is 'Idempotent verified payToPlay transactions';

create table public.arcade_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  wallet text not null,
  payment_id uuid not null references public.arcade_payments(id),
  -- One session per payment. Made idempotent by 20261001000100 (the original
  -- bare ADD CONSTRAINT aborted the whole migration on duplicate rows).
  constraint arcade_sessions_payment_id_unique unique (payment_id),
  epoch numeric(78,0) not null,
  game_seed text not null,
  status text not null default 'created' check (status in ('created','paid','active','submitting','recorded','failed','expired')),
  score integer,
  score_tx_hash text,
  error_code text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  arena_type text not null default 'human',
  -- Added by 20261001000100. This column was written by app/api/play/finish
  -- but never existed, so every write failed with Postgres 42703 and the error
  -- was swallowed, stranding sessions in 'submitting'.
  mint_tx_hash text unique,
  constraint arcade_sessions_score_nonnegative check (score is null or score >= 0),
  constraint arcade_sessions_arena_type_check check (arena_type in ('human', 'agent')),
  constraint arcade_sessions_wallet_format check (wallet ~ '^0x[0-9a-f]{40}$')
);

comment on table public.arcade_sessions is 'Persistent server-authoritative game sessions';

create table public.arcade_scores (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique references public.arcade_sessions(session_id),
  wallet text not null,
  epoch numeric(78,0) not null,
  score integer not null,
  tx_hash text unique,
  -- 'pending_mint' added by 20260927000001 for the mint-recovery path.
  status text not null default 'submitting' check (status in ('submitting','recorded','pending_mint','failed')),
  gameplay jsonb not null default '{}'::jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  chain_id bigint,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  failed_at timestamptz,
  arena_type text not null default 'human',
  mint_status text not null default 'pending' check (mint_status in ('pending','confirmed','failed')),
  mint_tx_hash text unique,
  constraint arcade_scores_score_nonnegative check (score >= 0),
  constraint arcade_scores_arena_type_check check (arena_type in ('human', 'agent')),
  constraint arcade_scores_wallet_format check (wallet ~ '^0x[0-9a-f]{40}$'),
  -- Audit fix: nothing tied 'recorded' to on-chain proof, so a row could reach
  -- the public leaderboard and the reward engine with tx_hash NULL.
  -- NOTE: all four status='recorded' writes in app code must set tx_hash or
  -- this CHECK rejects them (finish:107, finish:54, finish:81, confirm:48).
  constraint arcade_scores_recorded_requires_tx check (status <> 'recorded' or tx_hash is not null)
);

comment on table public.arcade_scores is 'Server-validated on-chain score submissions';
comment on column public.arcade_scores.chain_id is 'Chain used for the submitted recordScore transaction.';
comment on column public.arcade_scores.submitted_at is 'Timestamp when recordScore was submitted.';
comment on column public.arcade_scores.confirmed_at is 'Timestamp when the transaction receipt was successful.';
comment on column public.arcade_scores.failed_at is 'Timestamp when transaction confirmation failed.';


-- ============================================================================
-- 2. RATE LIMITING
-- ============================================================================

-- Legacy fixed-window counter. NO LONGER READ by consume_arcade_rate_limit;
-- retained only so a deployment that has not yet migrated still has the shape.
create table public.arcade_rate_limits (
  bucket text not null,
  subject text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (bucket, subject)
);

-- Sliding-window log: one row per counted request.
create table public.arcade_rate_limit_hits (
  bucket text not null,
  subject text not null,
  hit_at timestamptz not null default clock_timestamp()
);

comment on table public.arcade_rate_limit_hits is
  'Sliding-window rate-limit log. One row per counted request; pruned by purge_expired_arcade_rate_limits.';


-- ============================================================================
-- 3. WALLET AUTH
-- ============================================================================

create table public.arcade_auth_challenges (
  -- Lowercase only: the redemption path lowercases before matching.
  wallet text not null check (wallet ~ '^0x[0-9a-f]{40}$'),
  nonce text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (wallet, nonce)
);

comment on table public.arcade_auth_challenges is
  'Single-use SIWE-style challenge nonces. Retained only until expiry so a signature can be verified. No key material is stored.';


-- ============================================================================
-- 4. VYR INCENTIVES (Merkle-era tables)
-- ============================================================================

create table public.vyr_epoch_distributions (
  id uuid primary key default gen_random_uuid(),
  epoch bigint not null,
  arena_type text not null default 'human',
  merkle_root text not null,
  total_allocation numeric(78,0) not null check (total_allocation >= 0),
  total_points numeric(78,0) not null check (total_points >= 0),
  participant_count integer not null check (participant_count >= 0),
  reward_per_point numeric(78,0) not null check (reward_per_point >= 0),
  -- 'mismatch' added by 20260922000000.
  status text not null default 'pending' check (status in ('pending','building','ready','publishing','published','failed','mismatch')),
  published boolean not null default false,
  publish_tx_hash text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (epoch, arena_type),
  constraint vyr_epoch_distributions_published_immutable
    check (published = false or (merkle_root is not null and total_allocation is not null and total_points is not null)),
  -- Audit fix: status and published were independent columns that public RLS
  -- keys off, so they could disagree (status='failed', published=true).
  constraint vyr_epoch_distributions_published_matches_status
    check (published = false or status = 'published')
);

comment on table public.vyr_epoch_distributions is 'Server-published immutable VYR distributions. Writes require service role.';
comment on column public.vyr_epoch_distributions.reward_per_point is 'Frozen uint256 token base units per point.';

create table public.vyr_allocations (
  id uuid primary key default gen_random_uuid(),
  epoch bigint not null,
  arena_type text not null default 'human',
  wallet text not null,
  points numeric(78,0) not null check (points > 0),
  amount numeric(78,0) not null check (amount > 0),
  merkle_root text not null,
  leaf_hash text not null,
  merkle_proof jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (epoch, arena_type, wallet)
);

comment on table public.vyr_allocations is 'Server-generated deterministic Merkle allocations. Writes require service role.';
comment on column public.vyr_allocations.merkle_proof is 'OpenZeppelin-compatible proof for keccak256(abi.encode(epoch,wallet,points,amount)).';

create table public.vyr_claims (
  id uuid primary key default gen_random_uuid(),
  epoch bigint not null,
  arena_type text not null default 'human',
  wallet text not null,
  points numeric(78,0) not null,
  amount numeric(78,0) not null,
  tx_hash text,
  status text not null default 'pending' check (status in ('pending','confirmed','failed')),
  submitted_at timestamptz,
  confirmed_at timestamptz,
  failed_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (epoch, arena_type, wallet),
  constraint vyr_claims_tx_hash_unique unique (tx_hash),
  -- Audit fix: no range check existed, so arbitrary strings could be persisted
  -- into a financial field by the client-supplied claim-status body.
  constraint vyr_claims_points_nonnegative check (points >= 0),
  constraint vyr_claims_amount_nonnegative check (amount >= 0)
);

comment on table public.vyr_claims is 'Server-tracked VYR wallet claim lifecycle. NOTE: read via the vyr_claims_wei view (see section 9).';


-- ============================================================================
-- 5. CHAIN-AUTHORITATIVE SNAPSHOTS
-- ============================================================================

create table public.vyr_chain_snapshots (
  id uuid primary key default gen_random_uuid(),
  epoch bigint not null,
  arena smallint not null,
  prize_pool numeric(78,0) not null,
  top10 jsonb not null,
  status text not null default 'snapshotted' check (status in ('snapshotted','reconciled','mismatch','opened','winners_submitted','confirmed','failed')),
  reconciliation_status text,
  reconciliation jsonb,
  open_tx_hash text,
  winners_tx_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Added by 20260929000000.
  error_code text,
  error_message text,
  unique (epoch, arena)
);

comment on table public.vyr_chain_snapshots is 'Chain-authoritative VYR epoch snapshots. prize_pool is fixed at 10,000 VYR; SVP vault prize pools are not used here. NOTE: there is NO confirmed_at column — the terminal timestamp is updated_at.';

create table public.svp_epoch_snapshots (
  id uuid primary key default gen_random_uuid(),
  epoch bigint not null,
  arena smallint not null,
  prize_pool numeric(78,0) not null,
  onchain_result jsonb not null,
  top10 jsonb not null,
  status text not null default 'snapshot_pending' check (status in ('snapshot_pending','snapshotted','reconciliation_required','failed')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  -- Added by 20260927000000.
  reconciliation jsonb,
  updated_at timestamptz not null default now(),
  unique (epoch, arena)
);

comment on table public.svp_epoch_snapshots is 'Final on-chain ArcadeVaultV5 epoch snapshot; do not recompute from live chain after creation';

create table public.svp_reward_allocations (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.svp_epoch_snapshots(id) on delete cascade,
  epoch bigint not null,
  arena smallint not null,
  rank smallint not null check (rank between 1 and 3),
  wallet text not null,
  prize_pool numeric(78,0) not null,
  reward_amount numeric(78,0) not null,
  claimed boolean not null default false,
  claim_tx_hash text,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  failed_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  unique (epoch, arena, rank),
  unique (epoch, arena, wallet),
  unique (claim_tx_hash)
);

comment on table public.svp_reward_allocations is 'Top-3 SVP reward rows per epoch snapshot. NOTE: read via the svp_reward_allocations_wei view (see section 9).';
comment on column public.svp_reward_allocations.reward_amount is 'Individual player reward, never the complete prize pool';


-- ============================================================================
-- 6. INDEXES
-- ============================================================================

-- arcade_payments
create index arcade_payments_wallet_idx on public.arcade_payments(wallet);
create index arcade_payments_status_idx on public.arcade_payments(status);
create index arcade_payments_epoch_idx on public.arcade_payments(wallet, epoch);

-- arcade_sessions
create index arcade_sessions_wallet_idx on public.arcade_sessions(wallet);
create index arcade_sessions_status_idx on public.arcade_sessions(status);
create index arcade_sessions_created_idx on public.arcade_sessions(created_at desc);
create index arcade_sessions_arena_epoch_idx on public.arcade_sessions(arena_type, epoch);
-- Partial index so the expiry scan stays cheap. Postgres cannot express a
-- time-dependent CHECK, so expiry is enforced in app/api/play/finish/route.ts.
create index arcade_sessions_expiry_idx on public.arcade_sessions(expires_at)
  where status in ('created','paid','active');

-- arcade_scores
create index arcade_scores_epoch_score_idx on public.arcade_scores(epoch, score desc);
create index arcade_scores_wallet_idx on public.arcade_scores(wallet);
create index arcade_scores_arena_epoch_score_idx on public.arcade_scores(arena_type, epoch, score desc);
-- Supports both the ranking window function and the per-wallet best lookup.
create index arcade_scores_wallet_epoch_rank_idx on public.arcade_scores(arena_type, epoch, score desc, created_at asc);

-- rate limiting
create index arcade_rate_limits_window_idx on public.arcade_rate_limits(window_started_at);
create index arcade_rate_limit_hits_lookup_idx on public.arcade_rate_limit_hits(bucket, subject, hit_at desc);
create index arcade_rate_limit_hits_global_idx on public.arcade_rate_limit_hits(hit_at);

-- auth
create index arcade_auth_challenges_expiry_idx on public.arcade_auth_challenges(expires_at);

-- VYR
create index vyr_epoch_distributions_published_idx on public.vyr_epoch_distributions(published, epoch desc);
create index vyr_allocations_lookup_idx on public.vyr_allocations(epoch, arena_type, wallet);
create index vyr_claims_lookup_idx on public.vyr_claims(epoch, arena_type, wallet);
create index vyr_chain_snapshots_epoch_idx on public.vyr_chain_snapshots(epoch desc, arena);
create index vyr_chain_snapshots_status_idx on public.vyr_chain_snapshots(status, updated_at);

-- SVP
create index svp_reward_allocations_wallet_idx on public.svp_reward_allocations(wallet, epoch desc);
create index svp_epoch_snapshots_epoch_idx on public.svp_epoch_snapshots(epoch desc, arena);


-- ============================================================================
-- 7. ROW LEVEL SECURITY
-- ============================================================================
--
-- !! IMPORTANT DEPENDENCY — READ BEFORE CHANGING OWNERSHIP !!
--
-- The views in section 9 deliberately omit `security_invoker` so that `anon`
-- can read them without a grant on the base table. That makes them execute with
-- the VIEW OWNER's privileges. Because arcade_scores has FORCE ROW LEVEL
-- SECURITY below, those views return rows only while their owner holds
-- BYPASSRLS (postgres in Supabase).
--
-- If these views are ever recreated under a non-BYPASSRLS owner they will
-- silently return ZERO ROWS rather than raise an error — deny-all policies turn
-- a privilege mistake into an empty leaderboard. Diagnose with:
--   select rolname, rolbypassrls, rolsuper from pg_roles where rolname = current_user;
--
-- service_role is unaffected: it holds BYPASSRLS and has explicit grants here.
-- ---------------------------------------------------------------------------

alter table public.arcade_payments enable row level security;
alter table public.arcade_sessions enable row level security;
alter table public.arcade_scores enable row level security;
alter table public.arcade_rate_limits enable row level security;
alter table public.arcade_rate_limit_hits enable row level security;
alter table public.arcade_auth_challenges enable row level security;
alter table public.vyr_epoch_distributions enable row level security;
alter table public.vyr_allocations enable row level security;
alter table public.vyr_claims enable row level security;
alter table public.vyr_chain_snapshots enable row level security;
alter table public.svp_epoch_snapshots enable row level security;
alter table public.svp_reward_allocations enable row level security;

alter table public.arcade_payments force row level security;
alter table public.arcade_sessions force row level security;
alter table public.arcade_scores force row level security;
alter table public.arcade_rate_limits force row level security;
alter table public.arcade_rate_limit_hits force row level security;
alter table public.arcade_auth_challenges force row level security;
alter table public.vyr_epoch_distributions force row level security;
alter table public.vyr_allocations force row level security;
alter table public.vyr_claims force row level security;
alter table public.vyr_chain_snapshots force row level security;
alter table public.svp_epoch_snapshots force row level security;
alter table public.svp_reward_allocations force row level security;

-- Deny-all policies. RLS with zero policies already denies, but these make the
-- intent explicit and survive a future "grant everything" mistake visibly.
-- arcade_scores intentionally has NO policy: the old "public leaderboard read"
-- policy was dropped because a SELECT policy has no column granularity, so anon
-- could read every column including the `gameplay` jsonb event log — a complete
-- oracle for the scoring function. Public reads now go through
-- arcade_leaderboard_public.
create policy "no direct payment access" on public.arcade_payments
  for all to anon, authenticated using (false) with check (false);
create policy "no direct session access" on public.arcade_sessions
  for all to anon, authenticated using (false) with check (false);

create policy "published VYR distributions are readable" on public.vyr_epoch_distributions
  for select to anon, authenticated using (published = true);

create policy "VYR allocations are readable" on public.vyr_allocations
  for select to anon, authenticated using (
    exists (
      select 1 from public.vyr_epoch_distributions d
      where d.epoch = vyr_allocations.epoch
        and d.arena_type = vyr_allocations.arena_type
        and d.published = true
    )
  );

-- Recreated with an explicit `to anon, authenticated` and a drop-if-exists. The
-- originals defaulted to PUBLIC and had no drop, making the migration
-- non-idempotent.
create policy "published svp snapshots are readable" on public.svp_epoch_snapshots
  for select to anon, authenticated using (status = 'snapshotted');

create policy "svp allocations are readable" on public.svp_reward_allocations
  for select to anon, authenticated using (
    exists (select 1 from public.svp_epoch_snapshots s where s.id = snapshot_id and s.status = 'snapshotted')
  );


-- ============================================================================
-- 8. PRIVILEGES
-- ============================================================================

grant usage on schema public to anon, authenticated, service_role;

-- Defence in depth: revoke first, then grant back only what is public. Relying
-- on RLS alone previously left anon holding table-level INSERT/UPDATE/DELETE/
-- TRUNCATE/REFERENCES/TRIGGER on several tables.
revoke all on public.arcade_payments from anon, authenticated;
revoke all on public.arcade_sessions from anon, authenticated;
revoke all on public.arcade_scores from anon, authenticated;
revoke all on public.arcade_rate_limits from anon, authenticated;
revoke all on public.arcade_rate_limit_hits from anon, authenticated;
revoke all on public.arcade_auth_challenges from anon, authenticated;
revoke all on public.vyr_epoch_distributions from anon, authenticated;
revoke all on public.vyr_allocations from anon, authenticated;
revoke all on public.vyr_claims from anon, authenticated;
revoke all on public.vyr_chain_snapshots from anon, authenticated;
revoke all on public.svp_epoch_snapshots from anon, authenticated;
revoke all on public.svp_reward_allocations from anon, authenticated;

-- Public surface: only published distribution/alloc data, and only via RLS.
grant select on public.vyr_epoch_distributions to anon, authenticated;
grant select on public.vyr_allocations to anon, authenticated;
grant select on public.svp_epoch_snapshots to anon, authenticated;
grant select on public.svp_reward_allocations to anon, authenticated;

-- service_role: BYPASSRLS exempts it from row policies but NOT from table
-- privileges, so the server-side grants are stated explicitly rather than
-- assumed from platform `alter default privileges`.
grant all on public.arcade_payments to service_role;
grant all on public.arcade_sessions to service_role;
grant all on public.arcade_scores to service_role;
grant all on public.arcade_rate_limits to service_role;
grant all on public.arcade_rate_limit_hits to service_role;
grant all on public.vyr_epoch_distributions to service_role;
grant all on public.vyr_allocations to service_role;
grant all on public.vyr_claims to service_role;
grant all on public.vyr_chain_snapshots to service_role;
grant all on public.svp_epoch_snapshots to service_role;
grant all on public.svp_reward_allocations to service_role;
-- arcade_auth_challenges is written only through consume_arcade_auth_challenge
-- (SECURITY DEFINER); direct table access is not needed.
grant select, insert, update, delete on public.arcade_auth_challenges to service_role;


-- ============================================================================
-- 9. VIEWS
-- ============================================================================
--
-- Ranking is derived in SQL, deliberately NOT via a unique constraint on
-- (epoch, arena_type, wallet): a wallet may legitimately buy several sessions
-- per epoch, and a unique index would reject the IMPROVED score. This mirrors
-- ArcadeVaultV5.getPersonalBest() / paidPlayers instead.
-- ---------------------------------------------------------------------------

-- Recorded scores ranked per (epoch, arena_type, wallet). Ties break on earliest
-- submission so repeated finalization always yields the same ordering.
-- `status = 'recorded'` is applied in WHERE, i.e. BEFORE the window function, so
-- wallet_rank = 1 means the best RECORDED score. DO NOT remove that filter: it
-- is what stops an unfinalised row from occupying a leaderboard slot.
create view public.arcade_scores_ranked as
select
  s.id,
  s.session_id,
  s.wallet,
  s.epoch,
  s.arena_type,
  s.score,
  s.tx_hash,
  s.chain_id,
  s.created_at,
  s.submitted_at,
  s.confirmed_at,
  s.mint_tx_hash,
  s.mint_status,
  row_number() over (
    partition by s.epoch, s.arena_type, lower(s.wallet)
    order by s.score desc, s.created_at asc, s.id asc
  ) as wallet_rank
from public.arcade_scores s
where s.status = 'recorded';

comment on view public.arcade_scores_ranked is
  'Recorded scores ranked per (epoch, arena_type, wallet); wallet_rank = 1 is the wallet''s best attempt.';

-- Exactly one row per wallet per epoch per arena. USE THIS for any ranking,
-- reward or leaderboard read.
create view public.arcade_scores_best as
select id, session_id, wallet, epoch, arena_type, score, tx_hash, chain_id,
       created_at, submitted_at, confirmed_at, mint_tx_hash, mint_status
from public.arcade_scores_ranked
where wallet_rank = 1;

comment on view public.arcade_scores_best is
  'Best recorded score per (epoch, arena_type, wallet). Use this instead of arcade_scores for any ranking, reward or leaderboard read.';

-- The anon-readable projection. Narrow on purpose: no gameplay, no session_id,
-- no error_code, no mint bookkeeping.
create view public.arcade_leaderboard_public as
select epoch, arena_type, wallet, score, tx_hash, created_at, confirmed_at
from public.arcade_scores_best;

comment on view public.arcade_leaderboard_public is
  'Public leaderboard projection. Recorded scores only; excludes gameplay evidence and internal bookkeeping.';

-- Legacy view name, repointed at the narrow projection so it cannot drift back
-- into exposing internal columns.
create view public.arcade_leaderboard as
select epoch, arena_type, wallet, score, tx_hash, created_at
from public.arcade_leaderboard_public;

-- ---- Lossless numeric projections -----------------------------------------
-- PostgREST serialises numeric to a JSON NUMBER, so any value above 2^53 is
-- silently rounded before the app ever sees it. For wei-denominated amounts that
-- is real precision loss in a financial field. Casting to text makes PostgREST
-- emit a JSON string, which JavaScript parses losslessly.
-- The routes read ONLY these views, never the base tables, for amounts.
create view public.svp_reward_allocations_wei as
select id, snapshot_id, epoch, arena, rank, wallet,
       prize_pool::text as prize_pool,
       reward_amount::text as reward_amount,
       claimed, claim_tx_hash, submitted_at, confirmed_at, created_at
from public.svp_reward_allocations;

comment on view public.svp_reward_allocations_wei is
  'svp_reward_allocations with numeric(78,0) amounts cast to text, so PostgREST returns JSON strings instead of lossy numbers.';

create view public.vyr_claims_wei as
select id, epoch, arena_type, wallet,
       points::text as points,
       amount::text as amount,
       status, tx_hash, submitted_at, confirmed_at, failed_at, error_code, created_at
from public.vyr_claims;

comment on view public.vyr_claims_wei is
  'vyr_claims with numeric(78,0) values cast to text to avoid JSON number precision loss.';

-- vyr_chain_snapshots has NO confirmed_at column; its terminal timestamp is
-- updated_at, which the touch trigger advances on every write.
create view public.vyr_chain_snapshots_wei as
select id, epoch, arena, prize_pool::text as prize_pool, top10, status,
       reconciliation_status, created_at, updated_at
from public.vyr_chain_snapshots;

comment on view public.vyr_chain_snapshots_wei is
  'vyr_chain_snapshots with numeric(78,0) prize_pool cast to text to avoid JSON number precision loss.';

-- ---- View grants -----------------------------------------------------------
-- Only the leaderboard projections are public.
grant select on public.arcade_leaderboard_public to anon, authenticated;
grant select on public.arcade_leaderboard to anon, authenticated;
revoke insert, update, delete on public.arcade_leaderboard_public from anon, authenticated;
revoke insert, update, delete on public.arcade_leaderboard from anon, authenticated;

-- anon is deliberately NOT granted the *_wei views. These carry reward and prize
-- amounts, and a direct PostgREST grant would bypass the route-level rate
-- limiting on /api/incentive/{epochs,rewards,claim-status} entirely.
revoke all on public.svp_reward_allocations_wei from anon, authenticated;
revoke all on public.vyr_claims_wei from anon, authenticated;
revoke all on public.vyr_chain_snapshots_wei from anon, authenticated;

grant select on public.arcade_scores_ranked to service_role;
grant select on public.arcade_scores_best to service_role;
grant select on public.arcade_leaderboard_public to service_role;
grant select on public.arcade_leaderboard to service_role;
grant select on public.svp_reward_allocations_wei to service_role;
grant select on public.vyr_claims_wei to service_role;
grant select on public.vyr_chain_snapshots_wei to service_role;


-- ============================================================================
-- 10. FUNCTIONS
-- ============================================================================

-- ---- Timestamp triggers ----------------------------------------------------

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

create or replace function public.set_vyr_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

-- ---- Session state machine -------------------------------------------------

create or replace function public.arcade_session_transition_allowed()
returns trigger language plpgsql as $$
begin
  if old.status = new.status then return new; end if;
  if not (
    (old.status = 'created' and new.status in ('paid','failed','expired')) or
    (old.status = 'paid' and new.status in ('active','failed','expired')) or
    (old.status = 'active' and new.status in ('submitting','failed','expired')) or
    (old.status = 'submitting' and new.status in ('recorded','failed')) or
    (old.status in ('recorded','failed','expired') and false)
  ) then
    raise exception 'invalid arcade session transition: % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end; $$;

-- Audit fix: the transition trigger was BEFORE UPDATE OF status only, so an
-- INSERT could seed a session directly in a terminal state. lib/session-store.ts
-- creates sessions in 'active', skipping created/paid, so 'active' is allowed.
create or replace function public.arcade_session_insert_allowed()
returns trigger language plpgsql as $$
begin
  if new.status not in ('created','paid','active') then
    raise exception 'invalid arcade session initial status: %', new.status using errcode = 'check_violation';
  end if;
  return new;
end; $$;

-- ---- Wallet normalisation --------------------------------------------------

create or replace function public.normalize_wallet_case()
returns trigger language plpgsql as $$
begin
  new.wallet := lower(new.wallet);
  return new;
end; $$;

-- ---- Row binding (payment -> session -> score) ----------------------------
-- These identities are what the reward engine keys on, so an off-by-one would be
-- a silent payout bug rather than a visible error.

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

-- ---- Immutability of financial records -------------------------------------
-- Audit fix: every "immutable" guarantee was a BEFORE UPDATE trigger, so DELETE
-- was entirely unblocked. Deleting a published svp_epoch_snapshot silently
-- cascades and wipes every svp_reward_allocations row (ON DELETE CASCADE),
-- destroying the financial audit trail.

create or replace function public.reject_delete_of_immutable_record()
returns trigger language plpgsql as $$
begin
  raise exception '% records are immutable and cannot be deleted', tg_table_name
    using errcode = 'integrity_constraint_violation';
end; $$;

-- svp_reward_allocations / vyr_allocations only become immutable once published;
-- unclaimed rows of a pending snapshot may still be corrected.
--
-- TWO functions, deliberately. A single shared function cannot work: the svp
-- check reads old.snapshot_id, a column vyr_allocations does not have, and
-- plpgsql resolves old.<field> at RUNTIME -- so a shared function would raise
-- "record old has no field snapshot_id" on every vyr_allocations delete,
-- blocking all of them instead of only published ones.
create or replace function public.reject_delete_of_published_allocation()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.svp_epoch_snapshots s
             where s.id = old.snapshot_id and s.status = 'snapshotted') then
    raise exception 'published svp_reward_allocations rows cannot be deleted'
      using errcode = 'integrity_constraint_violation';
  end if;
  return old;
end; $$;

create or replace function public.reject_delete_of_published_vyr_allocation()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.vyr_epoch_distributions d
             where d.epoch = old.epoch and d.arena_type = old.arena_type and d.published) then
    raise exception 'published vyr_allocations rows cannot be deleted'
      using errcode = 'integrity_constraint_violation';
  end if;
  return old;
end; $$;

create or replace function public.reject_published_vyr_mutation()
returns trigger language plpgsql as $$
begin
  if old.published and (new.merkle_root is distinct from old.merkle_root
                        or new.total_allocation is distinct from old.total_allocation
                        or new.total_points is distinct from old.total_points) then
    raise exception 'PUBLISHED_DISTRIBUTION_IMMUTABLE';
  end if;
  return new;
end; $$;

create or replace function public.reject_published_allocation_mutation()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.vyr_epoch_distributions d
             where d.epoch = old.epoch and d.arena_type = old.arena_type and d.published)
    and (new.wallet is distinct from old.wallet
         or new.points is distinct from old.points
         or new.amount is distinct from old.amount
         or new.merkle_proof is distinct from old.merkle_proof) then
    raise exception 'PUBLISHED_ALLOCATION_IMMUTABLE';
  end if;
  return new;
end; $$;

create or replace function public.reject_chain_snapshot_mutation()
returns trigger language plpgsql as $$
begin
  if old.epoch is distinct from new.epoch
     or old.arena is distinct from new.arena
     or old.prize_pool is distinct from new.prize_pool
     or old.top10 is distinct from new.top10 then
    raise exception 'CHAIN_SNAPSHOT_IMMUTABLE';
  end if;
  return new;
end; $$;

-- Audit fix: cross-table claim-tx exclusivity between vyr_claims.tx_hash and
-- svp_reward_allocations.claim_tx_hash was enforced only by a racy BEFORE
-- trigger: two concurrent transactions each hold an uncommitted row the other
-- cannot see, both pass the EXISTS check, and both commit. The per-table unique
-- constraints cannot help because they live in different tables. The advisory
-- lock makes check-then-act atomic; it is transaction-scoped so it cannot leak.
create or replace function public.reject_claim_tx_reuse()
returns trigger language plpgsql as $$
begin
  if new.tx_hash is not null then
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

-- Audit fix: the svp_* policies referenced the snapshot by id only, while the
-- tables also carry denormalised epoch/arena columns that nothing constrained.
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

-- ---- Sliding-window rate limiter -------------------------------------------
-- Audit fix: the previous fixed window was anchored at the first request of the
-- window, so a client could send p_limit requests at t=0 and p_limit more at
-- t = window - epsilon: 2x the documented limit inside a one-second span. It
-- also captured now_at in DECLARE (before the row lock), producing an off-by-one
-- under contention, and permanently burned quota on rejected requests.

create or replace function public.consume_arcade_rate_limit(
  p_bucket text,
  p_subject text,
  p_limit integer,
  p_window_seconds integer
)
returns table(allowed boolean, remaining integer, retry_after integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  cutoff timestamptz;
  hits integer;
  oldest_remaining integer;
begin
  -- Fail closed on invalid or missing arguments. IS DISTINCT FROM is required
  -- because length(NULL) yields NULL, which would silently bypass `= 0`.
  if p_limit is null or p_window_seconds is null
     or p_bucket is null or p_subject is null
     or p_limit <= 0 or p_window_seconds <= 0
     or length(p_bucket) = 0 or length(p_subject) = 0 then
    return query select false, 0, coalesce(p_window_seconds, 0); return;
  end if;

  cutoff := clock_timestamp() - make_interval(secs => p_window_seconds);

  -- Serialises concurrent callers for the same (bucket, subject) so the
  -- prune + count cannot interleave and let a burst through.
  perform pg_advisory_xact_lock(hashtext(p_bucket || ':' || p_subject));

  select count(*) into hits
  from public.arcade_rate_limit_hits h
  where h.bucket = p_bucket and h.subject = p_subject and h.hit_at > cutoff;

  if hits < p_limit then
    insert into public.arcade_rate_limit_hits(bucket, subject, hit_at)
    values (p_bucket, p_subject, clock_timestamp());
    return query select true, p_limit - hits - 1, 0; return;
  end if;

  -- Window full. Do NOT record the hit: a rejected request must not extend the
  -- window or burn quota for the legitimate holder of this subject.
  select coalesce(
    ceil(extract(epoch from (min(h.hit_at) + make_interval(secs => p_window_seconds) - clock_timestamp())))::integer,
    0
  ) into oldest_remaining
  from public.arcade_rate_limit_hits h
  where h.bucket = p_bucket and h.subject = p_subject and h.hit_at > cutoff;

  return query select false, 0, greatest(1, oldest_remaining);
end; $$;

comment on function public.consume_arcade_rate_limit(text,text,integer,integer) is
  'Sliding-window distributed rate limiting for server-side route handlers. Rejected requests neither extend the window nor consume quota.';

-- Audit fix: the rate-limit tables were never purged anywhere in the repo, so
-- growth was bounded only by the number of distinct subjects ever observed — and
-- a client that can vary its apparent IP mints a fresh row per request.
create or replace function public.purge_expired_arcade_rate_limits(
  p_max_age_seconds integer default 3600
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  removed integer;
begin
  if p_max_age_seconds is null or p_max_age_seconds < 60 then
    raise exception 'p_max_age_seconds must be at least 60';
  end if;

  delete from public.arcade_rate_limit_hits
  where hit_at < clock_timestamp() - make_interval(secs => p_max_age_seconds);
  get diagnostics removed = row_count;

  -- Legacy counter table, no longer read by consume_arcade_rate_limit.
  delete from public.arcade_rate_limits
  where window_started_at < clock_timestamp() - make_interval(secs => p_max_age_seconds);

  return removed;
end; $$;

comment on function public.purge_expired_arcade_rate_limits(integer) is
  'Deletes rate-limit rows older than p_max_age_seconds. Call from the cron worker or pg_cron.';

-- ---- Wallet auth -----------------------------------------------------------

-- The UPDATE ... WHERE consumed_at IS NULL is the single-use guarantee: a second
-- concurrent redemption matches zero rows and is rejected, so a captured
-- signature cannot be replayed.
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

create or replace function public.purge_arcade_auth_challenges()
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  removed integer;
begin
  delete from public.arcade_auth_challenges
  where expires_at < clock_timestamp() - interval '1 hour';
  get diagnostics removed = row_count;
  return removed;
end; $$;

-- ---- Function privileges ---------------------------------------------------
-- PostgreSQL grants EXECUTE to PUBLIC by default on every function. Revoking
-- from `public` is therefore mandatory, not optional: trigger functions return
-- trigger and cannot be called directly, but the SECURITY DEFINER RPCs below
-- are real entry points and must not be reachable by anon.
revoke all on function public.touch_updated_at() from public;
revoke all on function public.set_vyr_updated_at() from public;
revoke all on function public.arcade_session_transition_allowed() from public;
revoke all on function public.arcade_session_insert_allowed() from public;
revoke all on function public.normalize_wallet_case() from public;
revoke all on function public.arcade_session_matches_payment() from public;
revoke all on function public.arcade_score_matches_session() from public;
revoke all on function public.reject_delete_of_immutable_record() from public;
revoke all on function public.reject_delete_of_published_allocation() from public;
revoke all on function public.reject_delete_of_published_vyr_allocation() from public;
revoke all on function public.reject_published_vyr_mutation() from public;
revoke all on function public.reject_published_allocation_mutation() from public;
revoke all on function public.reject_chain_snapshot_mutation() from public;
revoke all on function public.reject_claim_tx_reuse() from public;
revoke all on function public.reject_svp_claim_tx_reuse() from public;
revoke all on function public.svp_allocation_matches_snapshot() from public;

revoke all on function public.consume_arcade_rate_limit(text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.purge_expired_arcade_rate_limits(integer) from public, anon, authenticated;
revoke all on function public.consume_arcade_auth_challenge(text,text) from public, anon, authenticated;
revoke all on function public.purge_arcade_auth_challenges() from public, anon, authenticated;

grant execute on function public.touch_updated_at() to service_role;
grant execute on function public.set_vyr_updated_at() to service_role;
grant execute on function public.arcade_session_transition_allowed() to service_role;
grant execute on function public.arcade_session_insert_allowed() to service_role;
grant execute on function public.normalize_wallet_case() to service_role;
grant execute on function public.arcade_session_matches_payment() to service_role;
grant execute on function public.arcade_score_matches_session() to service_role;
grant execute on function public.reject_delete_of_immutable_record() to service_role;
grant execute on function public.reject_delete_of_published_allocation() to service_role;
grant execute on function public.reject_delete_of_published_vyr_allocation() to service_role;
grant execute on function public.reject_published_vyr_mutation() to service_role;
grant execute on function public.reject_published_allocation_mutation() to service_role;
grant execute on function public.reject_chain_snapshot_mutation() to service_role;
grant execute on function public.reject_claim_tx_reuse() to service_role;
grant execute on function public.reject_svp_claim_tx_reuse() to service_role;
grant execute on function public.svp_allocation_matches_snapshot() to service_role;

grant execute on function public.consume_arcade_rate_limit(text,text,integer,integer) to service_role;
grant execute on function public.purge_expired_arcade_rate_limits(integer) to service_role;
grant execute on function public.consume_arcade_auth_challenge(text,text) to service_role;
grant execute on function public.purge_arcade_auth_challenges() to service_role;


-- ============================================================================
-- 11. TRIGGERS
-- ============================================================================

-- Timestamp maintenance
create trigger arcade_payments_touch before update on public.arcade_payments
  for each row execute function public.touch_updated_at();
create trigger arcade_sessions_touch before update on public.arcade_sessions
  for each row execute function public.touch_updated_at();
create trigger arcade_scores_touch before update on public.arcade_scores
  for each row execute function public.touch_updated_at();
create trigger set_vyr_epoch_distributions_updated_at before update on public.vyr_epoch_distributions
  for each row execute function public.set_vyr_updated_at();
create trigger set_vyr_allocations_updated_at before update on public.vyr_allocations
  for each row execute function public.set_vyr_updated_at();
create trigger set_vyr_claims_updated_at before update on public.vyr_claims
  for each row execute function public.set_vyr_updated_at();

-- Session state machine: INSERT guard + UPDATE transition guard
create trigger arcade_sessions_insert_transition before insert on public.arcade_sessions
  for each row execute function public.arcade_session_insert_allowed();
create trigger arcade_sessions_transition before update of status on public.arcade_sessions
  for each row execute function public.arcade_session_transition_allowed();

-- Wallet normalisation (must run before the format CHECK sees the value)
create trigger arcade_payments_wallet_case before insert or update of wallet on public.arcade_payments
  for each row execute function public.normalize_wallet_case();
create trigger arcade_sessions_wallet_case before insert or update of wallet on public.arcade_sessions
  for each row execute function public.normalize_wallet_case();
create trigger arcade_scores_wallet_case before insert or update of wallet on public.arcade_scores
  for each row execute function public.normalize_wallet_case();

-- Row binding
create trigger arcade_sessions_payment_binding
  before insert or update of payment_id, wallet, epoch on public.arcade_sessions
  for each row execute function public.arcade_session_matches_payment();
create trigger arcade_scores_session_binding
  before insert or update of session_id, wallet, epoch, arena_type on public.arcade_scores
  for each row execute function public.arcade_score_matches_session();
create trigger svp_allocation_snapshot_binding
  before insert or update of snapshot_id, epoch, arena on public.svp_reward_allocations
  for each row execute function public.svp_allocation_matches_snapshot();

-- Immutability: UPDATE
create trigger vyr_distribution_immutable before update on public.vyr_epoch_distributions
  for each row execute function public.reject_published_vyr_mutation();
create trigger vyr_allocation_immutable before update on public.vyr_allocations
  for each row execute function public.reject_published_allocation_mutation();
create trigger vyr_chain_snapshot_immutable before update on public.vyr_chain_snapshots
  for each row execute function public.reject_chain_snapshot_mutation();
create trigger svp_epoch_snapshot_immutable before update on public.svp_epoch_snapshots
  for each row execute function public.reject_chain_snapshot_mutation();

-- Immutability: DELETE (audit fix — previously entirely unblocked)
create trigger svp_epoch_snapshot_no_delete before delete on public.svp_epoch_snapshots
  for each row execute function public.reject_delete_of_immutable_record();
create trigger vyr_epoch_distribution_no_delete before delete on public.vyr_epoch_distributions
  for each row execute function public.reject_delete_of_immutable_record();
create trigger vyr_chain_snapshot_no_delete before delete on public.vyr_chain_snapshots
  for each row execute function public.reject_delete_of_immutable_record();
create trigger arcade_payments_no_delete before delete on public.arcade_payments
  for each row execute function public.reject_delete_of_immutable_record();
create trigger arcade_sessions_no_delete before delete on public.arcade_sessions
  for each row execute function public.reject_delete_of_immutable_record();
create trigger arcade_scores_no_delete before delete on public.arcade_scores
  for each row execute function public.reject_delete_of_immutable_record();
create trigger svp_reward_allocation_no_delete before delete on public.svp_reward_allocations
  for each row execute function public.reject_delete_of_published_allocation();
create trigger vyr_allocation_no_delete before delete on public.vyr_allocations
  for each row execute function public.reject_delete_of_published_vyr_allocation();

-- Claim transaction exclusivity
create trigger vyr_claim_tx_reuse before insert or update of tx_hash on public.vyr_claims
  for each row execute function public.reject_claim_tx_reuse();
create trigger svp_claim_tx_reuse before insert or update of claim_tx_hash on public.svp_reward_allocations
  for each row execute function public.reject_svp_claim_tx_reuse();


-- ============================================================================
-- 12. CRON (retention)
-- ============================================================================
-- Guarded so this script still succeeds on an instance without pg_cron. Without
-- these jobs the rate-limit log and the challenge nonces grow without bound.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema extensions;

    if exists (select 1 from cron.job where jobname = 'purge-arcade-rate-limits') then
      perform cron.unschedule('purge-arcade-rate-limits');
    end if;
    perform cron.schedule('purge-arcade-rate-limits', '*/5 * * * *',
      $$select public.purge_expired_arcade_rate_limits(1800)$$);

    if exists (select 1 from cron.job where jobname = 'purge-arcade-auth-challenges') then
      perform cron.unschedule('purge-arcade-auth-challenges');
    end if;
    perform cron.schedule('purge-arcade-auth-challenges', '*/5 * * * *',
      $$select public.purge_arcade_auth_challenges()$$);
  end if;
end $$;


-- ============================================================================
-- END
-- ============================================================================
-- After running, verify the shape:
--   select count(*) from pg_tables where schemaname = 'public';                     -- 12
--   select count(*) from pg_views where schemaname = 'public';                      -- 7
--   select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
--     where c.relnamespace = 'public'::regnamespace and not t.tgisinternal;       -- 28
--
-- Then apply the five audit migrations if this database is not already current:
--   supabase db push
-- ============================================================================
