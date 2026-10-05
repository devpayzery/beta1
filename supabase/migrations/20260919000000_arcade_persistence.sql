create table if not exists public.arcade_payments (
  id uuid primary key default gen_random_uuid(),
  tx_hash text not null unique,
  wallet text not null,
  chain_id bigint not null,
  amount_wei numeric(78,0) not null,
  status text not null default 'verified' check (status in ('pending','verified','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.arcade_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  wallet text not null,
  payment_id uuid not null references public.arcade_payments(id),
  epoch numeric(78,0) not null,
  game_seed text not null,
  status text not null default 'created' check (status in ('created','paid','active','submitting','recorded','failed','expired')),
  score integer,
  score_tx_hash text,
  error_code text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.arcade_scores (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique references public.arcade_sessions(session_id),
  wallet text not null,
  epoch numeric(78,0) not null,
  score integer not null check (score >= 0),
  tx_hash text unique,
  status text not null default 'submitting' check (status in ('submitting','recorded','failed')),
  gameplay jsonb not null default '{}'::jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists arcade_payments_wallet_idx on public.arcade_payments(wallet);
create index if not exists arcade_payments_status_idx on public.arcade_payments(status);
create index if not exists arcade_sessions_wallet_idx on public.arcade_sessions(wallet);
create index if not exists arcade_sessions_status_idx on public.arcade_sessions(status);
create index if not exists arcade_sessions_created_idx on public.arcade_sessions(created_at desc);
create index if not exists arcade_scores_epoch_score_idx on public.arcade_scores(epoch, score desc);
create index if not exists arcade_scores_wallet_idx on public.arcade_scores(wallet);

alter table public.arcade_payments enable row level security;
alter table public.arcade_sessions enable row level security;
alter table public.arcade_scores enable row level security;

-- All writes use the server-only service role. Public clients receive API responses only.
drop policy if exists "no direct payment access" on public.arcade_payments;
drop policy if exists "no direct session access" on public.arcade_sessions;
drop policy if exists "public leaderboard read" on public.arcade_scores;
create policy "no direct payment access" on public.arcade_payments for all to anon, authenticated using (false) with check (false);
create policy "no direct session access" on public.arcade_sessions for all to anon, authenticated using (false) with check (false);
create policy "public leaderboard read" on public.arcade_scores for select to anon, authenticated using (status = 'recorded');

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists arcade_payments_touch on public.arcade_payments;
drop trigger if exists arcade_sessions_touch on public.arcade_sessions;
drop trigger if exists arcade_scores_touch on public.arcade_scores;
create trigger arcade_payments_touch before update on public.arcade_payments for each row execute function public.touch_updated_at();
create trigger arcade_sessions_touch before update on public.arcade_sessions for each row execute function public.touch_updated_at();
create trigger arcade_scores_touch before update on public.arcade_scores for each row execute function public.touch_updated_at();

-- Existing MVP tables are intentionally not dropped; migrate data separately after validation.
comment on table public.arcade_sessions is 'Persistent server-authoritative game sessions';
comment on table public.arcade_scores is 'Server-validated on-chain score submissions';
comment on table public.arcade_payments is 'Idempotent verified payToPlay transactions';

create or replace view public.arcade_leaderboard with (security_invoker = true) as
select epoch, wallet, score, tx_hash, created_at
from public.arcade_scores
where status = 'recorded';
grant select on public.arcade_leaderboard to anon, authenticated;
revoke insert, update, delete on public.arcade_leaderboard from anon, authenticated;

-- Contract limitation: ScoreRecorded does not include sessionId, so historical event indexing
-- cannot map an on-chain score back to a session without correlating the signer submission tx.
-- Contract limitation: tie handling is first-highest score wins and no prize reservation exists.
-- Recommended contract change: emit sessionId and enforce a minimum payment / epoch snapshot on-chain.
