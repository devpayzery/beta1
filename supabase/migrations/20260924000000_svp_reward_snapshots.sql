create table if not exists public.svp_epoch_snapshots (
  id uuid primary key default gen_random_uuid(),
  epoch bigint not null,
  arena smallint not null,
  prize_pool numeric(78,0) not null,
  onchain_result jsonb not null,
  top10 jsonb not null,
  status text not null default 'snapshot_pending' check (status in ('snapshot_pending','snapshotted','reconciliation_required','failed')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unique (epoch, arena)
);

create table if not exists public.svp_reward_allocations (
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

alter table public.svp_epoch_snapshots enable row level security;
alter table public.svp_reward_allocations enable row level security;
create policy "published svp snapshots are readable" on public.svp_epoch_snapshots for select using (status = 'snapshotted');
create policy "svp allocations are readable" on public.svp_reward_allocations for select using (exists (select 1 from public.svp_epoch_snapshots s where s.id = snapshot_id and s.status = 'snapshotted'));
revoke insert, update, delete on public.svp_epoch_snapshots from anon, authenticated;
revoke insert, update, delete on public.svp_reward_allocations from anon, authenticated;
create index if not exists svp_reward_allocations_wallet_idx on public.svp_reward_allocations (wallet, epoch desc);
create index if not exists svp_epoch_snapshots_epoch_idx on public.svp_epoch_snapshots (epoch desc, arena);

alter table public.vyr_claims add constraint vyr_claims_tx_hash_unique unique (tx_hash);
alter table public.vyr_epoch_distributions add constraint vyr_epoch_distributions_published_immutable check (published = false or (merkle_root is not null and total_allocation is not null and total_points is not null));

comment on column public.svp_reward_allocations.reward_amount is 'Individual player reward, never the complete prize pool';
comment on table public.svp_epoch_snapshots is 'Final on-chain ArcadeVaultV5 epoch snapshot; do not recompute from live chain after creation';

create or replace function public.reject_published_vyr_mutation() returns trigger language plpgsql as $$
begin
  if old.published and (new.merkle_root is distinct from old.merkle_root or new.total_allocation is distinct from old.total_allocation or new.total_points is distinct from old.total_points) then
    raise exception 'PUBLISHED_DISTRIBUTION_IMMUTABLE';
  end if;
  return new;
end;
$$;
drop trigger if exists vyr_distribution_immutable on public.vyr_epoch_distributions;
create trigger vyr_distribution_immutable before update on public.vyr_epoch_distributions for each row execute function public.reject_published_vyr_mutation();

create or replace function public.reject_published_allocation_mutation() returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.vyr_epoch_distributions d where d.epoch = old.epoch and d.arena_type = old.arena_type and d.published)
    and (new.wallet is distinct from old.wallet or new.points is distinct from old.points or new.amount is distinct from old.amount or new.merkle_proof is distinct from old.merkle_proof) then
    raise exception 'PUBLISHED_ALLOCATION_IMMUTABLE';
  end if;
  return new;
end;
$$;
drop trigger if exists vyr_allocation_immutable on public.vyr_allocations;
create trigger vyr_allocation_immutable before update on public.vyr_allocations for each row execute function public.reject_published_allocation_mutation();

create or replace function public.reject_claim_tx_reuse() returns trigger language plpgsql as $$
begin
  if new.tx_hash is not null and exists (select 1 from public.vyr_claims c where c.tx_hash = new.tx_hash and c.id <> new.id) then
    raise exception 'CLAIM_TX_ALREADY_ASSOCIATED';
  end if;
  if new.tx_hash is not null and exists (select 1 from public.svp_reward_allocations a where a.claim_tx_hash = new.tx_hash and a.id <> new.id) then
    raise exception 'CLAIM_TX_ALREADY_ASSOCIATED';
  end if;
  return new;
end;
$$;
drop trigger if exists vyr_claim_tx_reuse on public.vyr_claims;
create trigger vyr_claim_tx_reuse before insert or update on public.vyr_claims for each row execute function public.reject_claim_tx_reuse();
create or replace function public.reject_svp_claim_tx_reuse() returns trigger language plpgsql as $$
begin
  if new.claim_tx_hash is not null and exists (select 1 from public.vyr_claims c where c.tx_hash = new.claim_tx_hash) then raise exception 'CLAIM_TX_ALREADY_ASSOCIATED'; end if;
  return new;
end;
$$;
create trigger svp_claim_tx_reuse before insert or update on public.svp_reward_allocations for each row execute function public.reject_svp_claim_tx_reuse();

revoke all on function public.reject_published_vyr_mutation() from public;
revoke all on function public.reject_published_allocation_mutation() from public;
revoke all on function public.reject_claim_tx_reuse() from public;
revoke all on function public.reject_svp_claim_tx_reuse() from public;
