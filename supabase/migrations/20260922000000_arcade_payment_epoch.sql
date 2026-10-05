alter table public.arcade_payments
  add column if not exists epoch numeric(78,0);

update public.arcade_payments p
set epoch = s.epoch
from public.arcade_sessions s
where s.payment_id = p.id
  and p.epoch is null;

-- Unknown legacy payments remain explicitly unknown; epoch 0 is not a valid Human epoch.
-- Keep the column nullable until each historical payment is reconciled from chain data.
alter table public.arcade_payments
  alter column epoch drop default;

create index if not exists arcade_payments_epoch_idx
  on public.arcade_payments (wallet, epoch);
