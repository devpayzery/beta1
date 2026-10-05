alter table public.vyr_epoch_distributions drop constraint if exists vyr_epoch_distributions_status_check;
alter table public.vyr_epoch_distributions add constraint vyr_epoch_distributions_status_check check (status in ('pending','building','ready','publishing','published','failed','mismatch'));
