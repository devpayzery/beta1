alter table public.arcade_sessions
  add constraint arcade_sessions_payment_id_unique unique (payment_id);
