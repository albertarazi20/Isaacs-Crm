-- app.plan_for (0350) answered "no plan" for a funding dated before every plan's effective_from: the seeded shop plan
-- is dated the migration day, so a funding backfilled from before it got the bare 50 % split, no override, no tiers,
-- no PSF share. Now a date no plan is effective on takes the newest plan the person has (their own first, then the
-- shop's) instead of none. A plan that is effective on the date still wins over any plan that is not, whoever owns
-- it; among those, the person's own newest, as before.
create or replace function app.plan_for(p_user uuid, p_on date) returns commission_plans
language sql stable set search_path = public, pg_temp as $$
  select * from commission_plans
   where user_id = p_user or user_id is null
   order by (effective_from <= p_on) desc, (user_id is not null) desc, effective_from desc
   limit 1
$$;
