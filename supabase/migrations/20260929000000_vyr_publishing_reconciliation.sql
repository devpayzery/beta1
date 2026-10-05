alter table public.vyr_chain_snapshots
  add column if not exists error_code text,
  add column if not exists error_message text,
  add column if not exists reconciliation_status text;

create index if not exists vyr_chain_snapshots_status_idx
  on public.vyr_chain_snapshots (status, updated_at);

comment on table public.vyr_chain_snapshots is 'Chain-authoritative VYR epoch snapshots. prize_pool is fixed at 10,000 VYR; SVP vault prize pools are not used here.';
