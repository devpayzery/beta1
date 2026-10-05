create table if not exists public.vyr_epoch_distributions (
  id uuid primary key default gen_random_uuid(),
  epoch bigint not null,
  arena_type text not null default 'human',
  merkle_root text not null,
  total_allocation numeric(78,0) not null check (total_allocation >= 0),
  total_points numeric(78,0) not null check (total_points >= 0),
  participant_count integer not null check (participant_count >= 0),
  reward_per_point numeric(78,0) not null check (reward_per_point >= 0),
  status text not null default 'pending' check (status in ('pending','building','ready','publishing','published','failed')),
  published boolean not null default false,
  publish_tx_hash text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (epoch, arena_type)
);

create table if not exists public.vyr_allocations (
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

create table if not exists public.vyr_claims (
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
  unique (epoch, arena_type, wallet)
);

create index if not exists vyr_epoch_distributions_published_idx on public.vyr_epoch_distributions (published, epoch desc);
create index if not exists vyr_allocations_lookup_idx on public.vyr_allocations (epoch, arena_type, wallet);
create index if not exists vyr_claims_lookup_idx on public.vyr_claims (epoch, arena_type, wallet);

alter table public.vyr_epoch_distributions enable row level security;
alter table public.vyr_allocations enable row level security;
alter table public.vyr_claims enable row level security;

 drop policy if exists "published VYR distributions are readable" on public.vyr_epoch_distributions;
create policy "published VYR distributions are readable" on public.vyr_epoch_distributions for select to anon, authenticated using (published = true);
 drop policy if exists "VYR allocations are readable" on public.vyr_allocations;
create policy "VYR allocations are readable" on public.vyr_allocations for select to anon, authenticated using (exists (select 1 from public.vyr_epoch_distributions d where d.epoch = vyr_allocations.epoch and d.arena_type = vyr_allocations.arena_type and d.published = true));
 drop policy if exists "VYR claims are readable" on public.vyr_claims;
revoke select on public.vyr_claims from anon, authenticated;

revoke insert, update, delete on public.vyr_epoch_distributions from anon, authenticated;
revoke insert, update, delete on public.vyr_allocations from anon, authenticated;
revoke insert, update, delete on public.vyr_claims from anon, authenticated;
revoke all on public.vyr_epoch_distributions from anon, authenticated;
revoke all on public.vyr_allocations from anon, authenticated;
revoke all on public.vyr_claims from anon, authenticated;
grant select on public.vyr_epoch_distributions, public.vyr_allocations to anon, authenticated;

comment on table public.vyr_epoch_distributions is 'Server-published immutable VYR distributions. Writes require service role.';
comment on table public.vyr_allocations is 'Server-generated deterministic Merkle allocations. Writes require service role.';
comment on table public.vyr_claims is 'Server-tracked VYR wallet claim lifecycle.';
comment on column public.vyr_allocations.merkle_proof is 'OpenZeppelin-compatible proof for keccak256(abi.encode(epoch,wallet,points,amount)).';
comment on column public.vyr_epoch_distributions.reward_per_point is 'Frozen uint256 token base units per point.';

create or replace function public.set_vyr_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists set_vyr_epoch_distributions_updated_at on public.vyr_epoch_distributions;
create trigger set_vyr_epoch_distributions_updated_at before update on public.vyr_epoch_distributions for each row execute function public.set_vyr_updated_at();
drop trigger if exists set_vyr_allocations_updated_at on public.vyr_allocations;
create trigger set_vyr_allocations_updated_at before update on public.vyr_allocations for each row execute function public.set_vyr_updated_at();
drop trigger if exists set_vyr_claims_updated_at on public.vyr_claims;
create trigger set_vyr_claims_updated_at before update on public.vyr_claims for each row execute function public.set_vyr_updated_at();
revoke execute on function public.set_vyr_updated_at() from public;
 grant execute on function public.set_vyr_updated_at() to postgres, service_role;
