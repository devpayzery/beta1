create table if not exists public.vyr_chain_snapshots (
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
  unique (epoch, arena)
);

alter table public.vyr_chain_snapshots enable row level security;
revoke all on public.vyr_chain_snapshots from anon, authenticated;
create index if not exists vyr_chain_snapshots_epoch_idx on public.vyr_chain_snapshots (epoch desc, arena);

alter table public.svp_epoch_snapshots add column if not exists reconciliation jsonb;
alter table public.svp_epoch_snapshots add column if not exists updated_at timestamptz not null default now();

create or replace function public.reject_chain_snapshot_mutation() returns trigger language plpgsql as $$
begin
  if old.epoch is distinct from new.epoch or old.arena is distinct from new.arena or old.prize_pool is distinct from new.prize_pool or old.top10 is distinct from new.top10 then raise exception 'CHAIN_SNAPSHOT_IMMUTABLE'; end if;
  return new;
end;
$$;
drop trigger if exists vyr_chain_snapshot_immutable on public.vyr_chain_snapshots;
create trigger vyr_chain_snapshot_immutable before update on public.vyr_chain_snapshots for each row execute function public.reject_chain_snapshot_mutation();
drop trigger if exists svp_epoch_snapshot_immutable on public.svp_epoch_snapshots;
create trigger svp_epoch_snapshot_immutable before update on public.svp_epoch_snapshots for each row execute function public.reject_chain_snapshot_mutation();
revoke all on function public.reject_chain_snapshot_mutation() from public;
