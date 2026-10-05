-- Audit remediation: replace the fixed-window rate limiter with a true sliding window.

-- FINDING (medium): consume_arcade_rate_limit used a fixed window anchored at the first request
-- of the window. Because window_started_at only advances once the window has fully elapsed, a
-- client could send p_limit requests at t=0 and p_limit more at t = window - epsilon, i.e. 2x the
-- limit inside a one-second span. That is a real bypass of the documented limit.
--
-- FINDING (low): now_at was captured with clock_timestamp() in the DECLARE block, i.e. before the
-- INSERT acquired the conflicting row's lock. Under contention the loser resumed with a stale
-- timestamp and re-evaluated both CASE expressions against the winner's already-reset
-- window_started_at, producing an off-by-one at the window boundary.
--
-- FINDING (medium): rejected requests permanently burned quota for the remainder of the window,
-- which amplified lockout when multiple clients shared a subject.
--
-- A fixed window cannot express any of these correctly. We move to a sliding-window log: one row
-- per counted request, with the window evaluated against real hit timestamps. The RPC signature is
-- unchanged, so lib/rate-limit.ts requires no modification.

create table if not exists public.arcade_rate_limit_hits (
  bucket text not null,
  subject text not null,
  hit_at timestamptz not null default clock_timestamp()
);

comment on table public.arcade_rate_limit_hits is
  'Sliding-window rate-limit log. One row per counted request; pruned by purge_expired_arcade_rate_limits.';

create index if not exists arcade_rate_limit_hits_lookup_idx
  on public.arcade_rate_limit_hits (bucket, subject, hit_at desc);

create index if not exists arcade_rate_limit_hits_global_idx
  on public.arcade_rate_limit_hits (hit_at);

alter table public.arcade_rate_limit_hits enable row level security;
alter table public.arcade_rate_limit_hits force row level security;
revoke all on public.arcade_rate_limit_hits from anon, authenticated;

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
  -- Fail closed on invalid or missing arguments. IS DISTINCT FROM is required because
 -- length(NULL) yields NULL, which would silently bypass a plain `= 0` guard.
  if p_limit is null or p_window_seconds is null
     or p_bucket is null or p_subject is null
     or p_limit <= 0 or p_window_seconds <= 0
     or length(p_bucket) = 0 or length(p_subject) = 0 then
    return query select false, 0, coalesce(p_window_seconds, 0); return;
  end if;

  cutoff := clock_timestamp() - make_interval(secs => p_window_seconds);

  -- Advisory lock on the subject serialises concurrent callers for the same (bucket, subject), so
  -- the prune + count below cannot interleave and let a burst through.
  perform pg_advisory_xact_lock(hashtext(p_bucket || ':' || p_subject));

  -- Count first, then record: the incoming request is admitted only if the window is not yet full.
  select count(*) into hits
  from public.arcade_rate_limit_hits h
  where h.bucket = p_bucket and h.subject = p_subject and h.hit_at > cutoff;

  if hits < p_limit then
    insert into public.arcade_rate_limit_hits(bucket, subject, hit_at)
    values (p_bucket, p_subject, clock_timestamp());
    return query select true, p_limit - hits - 1, 0; return;
  end if;

  -- Window is full. Do not record the hit: a rejected request must not extend the window or burn
  -- quota for the legitimate holder of this subject.
  select coalesce(
    ceil(extract(epoch from (min(h.hit_at) + make_interval(secs => p_window_seconds) - clock_timestamp())))::integer,
    0
  ) into oldest_remaining
  from public.arcade_rate_limit_hits h
  where h.bucket = p_bucket and h.subject = p_subject and h.hit_at > cutoff;

  return query select false, 0, greatest(1, oldest_remaining);
end; $$;

revoke all on function public.consume_arcade_rate_limit(text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.consume_arcade_rate_limit(text,text,integer,integer) to service_role;

comment on function public.consume_arcade_rate_limit is
  'Sliding-window distributed rate limiting for server-side route handlers. Rejected requests neither extend the window nor consume quota.';

-- Extend the purge to the hit log, including rows for subjects that will never be seen again.
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

  -- The legacy counter table is retained only for backwards compatibility with deployments that
  -- have not yet migrated; it is no longer read by consume_arcade_rate_limit.
  delete from public.arcade_rate_limits
  where window_started_at < clock_timestamp() - make_interval(secs => p_max_age_seconds);

  return removed;
end; $$;

revoke all on function public.purge_expired_arcade_rate_limits(integer) from public, anon, authenticated;
grant execute on function public.purge_expired_arcade_rate_limits(integer) to service_role;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'purge-arcade-rate-limits') then
      perform cron.unschedule('purge-arcade-rate-limits');
    end if;
    -- Own dollar-quote tag, for the reason documented in
    -- 20261001000200_immutability_and_rate_limit_retention.sql: a bare double-dollar sequence
    -- here would close the enclosing DO block instead of opening a string, and the error would
    -- point at this command rather than at the cause.
    perform cron.schedule('purge-arcade-rate-limits', '*/5 * * * *',
      $cron$select public.purge_expired_arcade_rate_limits(1800)$cron$);
  end if;
end $$;