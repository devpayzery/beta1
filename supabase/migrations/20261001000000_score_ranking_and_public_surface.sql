-- Audit remediation: score ranking integrity and public read surface.
--
-- FINDING (critical): arcade_scores had no uniqueness of any kind beyond session_id and
-- tx_hash. A wallet could hold several sessions in the same epoch and therefore several
-- rows for that epoch, occupying several top-10 slots. The only guard was a single
-- application-level assertion in lib/reward-finalization.ts.
--
-- DESIGN DECISION: we deliberately do NOT add a unique constraint on
-- (epoch, arena_type, lower(wallet)). A wallet may legitimately buy several sessions per
-- epoch, and a unique constraint would reject the *improved* score, permanently stranding
-- the player on their first attempt. Instead we keep one row per session (the audit trail)
-- and derive rankings from the best score per wallet, which mirrors what the chain does
-- (ArcadeVaultV5 exposes getPersonalBest(arena, epoch, player) and paidPlayers).
--
-- FINDING (high): the policy "public leaderboard read" was a FOR SELECT policy, which has no
-- column granularity. anon could therefore read every column of every recorded score,
-- including the `gameplay` jsonb event log, session_id, mint_tx_hash and error_code. The
-- event log is a complete oracle for the client-side scoring function.

-- Best score per wallet per epoch per arena. Ranking is derived here, not in app code.
-- Ties are broken deterministically by earliest submission so that repeated finalization
-- of the same epoch always produces the same ordering.
create or replace view public.arcade_scores_ranked as
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

-- Convenience projection: exactly one row per wallet per epoch per arena.
create or replace view public.arcade_scores_best as
select id, session_id, wallet, epoch, arena_type, score, tx_hash, chain_id, created_at, submitted_at, confirmed_at, mint_tx_hash, mint_status
from public.arcade_scores_ranked
where wallet_rank = 1;

comment on view public.arcade_scores_best is
  'Best recorded score per (epoch, arena_type, wallet). Use this instead of arcade_scores for any ranking, reward or leaderboard read.';

-- Supports the ranking window and the per-wallet best lookup.
create index if not exists arcade_scores_wallet_epoch_rank_idx
  on public.arcade_scores (arena_type, epoch, score desc, created_at asc);

-- Public read surface: a narrow projection that deliberately omits `gameplay`,
-- session_id, error_code and the mint bookkeeping columns.
--
-- These views intentionally run with the view owner's privileges (the default, i.e. NOT
-- security_invoker) so that anon can read them without a grant on the base table. Because
-- the base table's RLS is therefore not applied, the `status = 'recorded'` filter is
-- enforced inside arcade_scores_ranked and must not be removed.
--
-- Coupled with `force row level security` on arcade_scores (see 20261001000200), these views
-- return rows only while their owner holds BYPASSRLS. Recreating them under a plain owner would make
-- them return zero rows silently, not fail loudly.
create or replace view public.arcade_leaderboard_public as
select epoch, arena_type, wallet, score, tx_hash, created_at, confirmed_at
from public.arcade_scores_best;

comment on view public.arcade_leaderboard_public is
  'Public leaderboard projection. Recorded scores only; excludes gameplay evidence and internal bookkeeping.';

revoke all on public.arcade_leaderboard_public from anon, authenticated;
grant select on public.arcade_leaderboard_public to anon, authenticated;

-- Replace the over-broad table policy with nothing: anon must go through the narrow view.
drop policy if exists "public leaderboard read" on public.arcade_scores;
revoke select on public.arcade_scores from anon, authenticated;

-- The legacy view exposed tx_hash/session-adjacent data and no arena filter; point it at the
-- same projection so it cannot drift back into exposing internal columns.
drop view if exists public.arcade_leaderboard;
create or replace view public.arcade_leaderboard as
select epoch, arena_type, wallet, score, tx_hash, created_at
from public.arcade_leaderboard_public;

grant select on public.arcade_leaderboard to anon, authenticated;
revoke insert, update, delete on public.arcade_leaderboard from anon, authenticated;

-- Defence in depth: deny-all policies remain, but the arcade tables are now also hardened at
-- the privilege layer rather than relying on RLS alone (previously anon retained table-level
-- INSERT/UPDATE/DELETE/TRUNCATE on these three tables).
revoke all on public.arcade_payments from anon, authenticated;
revoke all on public.arcade_sessions from anon, authenticated;

-- The server reads arcade_scores_best through the service-role client (lib/supabase/admin.ts) in
-- /api/leaderboard, /api/history, /api/incentive/rewards and lib/reward-finalization.ts. BYPASSRLS
-- exempts service_role from row policies but NOT from table privileges, so without an explicit grant
-- every one of those reads fails with 42501 on a project whose `alter default privileges` do not
-- cover newly created views. Granted explicitly so the dependency is visible here rather than
-- inherited from platform bootstrap defaults.
grant select on public.arcade_scores_ranked to service_role;
grant select on public.arcade_scores_best to service_role;
grant select on public.arcade_leaderboard_public to service_role;
grant select on public.arcade_leaderboard to service_role;

grant usage on schema public to anon, authenticated;
grant usage on schema public to service_role;