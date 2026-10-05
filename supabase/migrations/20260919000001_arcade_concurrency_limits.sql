create table if not exists public.arcade_rate_limits (
  bucket text not null,
  subject text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (bucket, subject)
);

create index if not exists arcade_rate_limits_window_idx on public.arcade_rate_limits(window_started_at);
alter table public.arcade_rate_limits enable row level security;
revoke all on public.arcade_rate_limits from anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'arcade_scores_score_nonnegative') then
    alter table public.arcade_scores add constraint arcade_scores_score_nonnegative check (score >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'arcade_sessions_score_nonnegative') then
    alter table public.arcade_sessions add constraint arcade_sessions_score_nonnegative check (score is null or score >= 0);
  end if;
end $$;

alter table public.arcade_scores add column if not exists chain_id bigint;
alter table public.arcade_scores add column if not exists submitted_at timestamptz;
alter table public.arcade_scores add column if not exists confirmed_at timestamptz;
alter table public.arcade_scores add column if not exists failed_at timestamptz;

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
drop trigger if exists arcade_sessions_transition on public.arcade_sessions;
create trigger arcade_sessions_transition before update of status on public.arcade_sessions for each row execute function public.arcade_session_transition_allowed();

create or replace function public.consume_arcade_rate_limit(
  p_bucket text,
  p_subject text,
  p_limit integer,
  p_window_seconds integer
)
returns table(allowed boolean, remaining integer, retry_after integer)
language plpgsql security definer set search_path = public as $$
declare
  now_at timestamptz := clock_timestamp();
  current_row public.arcade_rate_limits%rowtype;
  elapsed integer;
begin
  if p_limit <= 0 or p_window_seconds <= 0 or length(p_bucket) = 0 or length(p_subject) = 0 then
    return query select false, 0, p_window_seconds; return;
  end if;
  insert into public.arcade_rate_limits(bucket, subject, window_started_at, request_count)
  values (p_bucket, p_subject, now_at, 1)
  on conflict (bucket, subject) do update set
    window_started_at = case when now_at >= public.arcade_rate_limits.window_started_at + make_interval(secs => p_window_seconds) then now_at else public.arcade_rate_limits.window_started_at end,
    request_count = case when now_at >= public.arcade_rate_limits.window_started_at + make_interval(secs => p_window_seconds) then 1 else public.arcade_rate_limits.request_count + 1 end
  returning * into current_row;
  elapsed := greatest(0, p_window_seconds - floor(extract(epoch from (current_row.window_started_at + make_interval(secs => p_window_seconds) - now_at)))::integer);
  return query select current_row.request_count <= p_limit, greatest(0, p_limit - current_row.request_count), case when current_row.request_count <= p_limit then 0 else elapsed end;
end; $$;
revoke all on function public.consume_arcade_rate_limit(text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.consume_arcade_rate_limit(text,text,integer,integer) to service_role;

comment on function public.consume_arcade_rate_limit is 'Atomic distributed rate limiting for server-side route handlers.';
comment on table public.arcade_rate_limits is 'Shared serverless rate-limit buckets; never exposed through the Data API.';
comment on column public.arcade_scores.chain_id is 'Chain used for the submitted recordScore transaction.';
comment on column public.arcade_scores.submitted_at is 'Timestamp when recordScore was submitted.';
comment on column public.arcade_scores.confirmed_at is 'Timestamp when the transaction receipt was successful.';
comment on column public.arcade_scores.failed_at is 'Timestamp when transaction confirmation failed.';

-- CONTRACT LIMITATION: the current ScoreRecorded event omits sessionId.
-- REQUIRED CONTRACT CHANGE: emit sessionId (bytes32 indexed) with player, epoch and score.
-- CONTRACT LIMITATION: payToPlay only requires msg.value > 0; REQUIRED CONTRACT CHANGE: enforce configured fee on-chain.
-- CONTRACT LIMITATION: claimPrize scans all scores, first maximum wins ties, and zeroes the pool only after winner validation.
-- REQUIRED CONTRACT CHANGE: snapshot winner/prize at epoch close and make tie policy explicit without an unbounded claim-time scan.
