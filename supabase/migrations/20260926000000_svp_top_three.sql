alter table public.svp_reward_allocations drop constraint if exists svp_reward_allocations_rank_check;
alter table public.svp_reward_allocations add constraint svp_reward_allocations_rank_check check (rank between 1 and 3);
