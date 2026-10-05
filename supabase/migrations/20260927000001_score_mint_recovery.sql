alter table public.arcade_scores drop constraint if exists arcade_scores_status_check;
alter table public.arcade_scores add constraint arcade_scores_status_check check (status in ('submitting','recorded','pending_mint','failed'));
alter table public.arcade_scores add column if not exists mint_status text not null default 'pending' check (mint_status in ('pending','confirmed','failed'));
alter table public.arcade_scores add column if not exists mint_tx_hash text unique;
