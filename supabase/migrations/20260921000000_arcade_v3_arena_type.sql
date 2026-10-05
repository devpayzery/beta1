alter table public.arcade_sessions
  add column if not exists arena_type text not null default 'human';

alter table public.arcade_scores
  add column if not exists arena_type text not null default 'human';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.arcade_sessions'::regclass
      and conname = 'arcade_sessions_arena_type_check'
  ) then
    alter table public.arcade_sessions
      add constraint arcade_sessions_arena_type_check check (arena_type in ('human', 'agent'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.arcade_scores'::regclass
      and conname = 'arcade_scores_arena_type_check'
  ) then
    alter table public.arcade_scores
      add constraint arcade_scores_arena_type_check check (arena_type in ('human', 'agent'));
  end if;
end $$;

create index if not exists arcade_sessions_arena_epoch_idx
  on public.arcade_sessions (arena_type, epoch);

create index if not exists arcade_scores_arena_epoch_score_idx
  on public.arcade_scores (arena_type, epoch, score desc);

comment on column public.arcade_sessions.arena_type is 'Arena selected for the session; historical rows default to human.';
comment on column public.arcade_scores.arena_type is 'Arena used by the on-chain score submission; historical rows default to human.';

alter table public.arcade_sessions validate constraint arcade_sessions_arena_type_check;
alter table public.arcade_scores validate constraint arcade_scores_arena_type_check;

update public.arcade_scores
set arena_type = 'human'
where arena_type is null;

update public.arcade_sessions
set arena_type = 'human'
where arena_type is null;

drop view if exists public.arcade_leaderboard;

create view public.arcade_leaderboard with (security_invoker = true) as
select arena_type, epoch, wallet, score, tx_hash, created_at
from public.arcade_scores
where status = 'recorded';

grant select on public.arcade_leaderboard to anon, authenticated;
revoke insert, update, delete on public.arcade_leaderboard from anon, authenticated;

-- Agent remains intentionally inactive in the deployed contract; this migration only records arena ownership.
