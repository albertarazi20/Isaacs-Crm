-- 0140: a lead token can only add so many NEW merchants a day (review-3A A-10). Without a cap, a leaked token could
-- bury Today in junk cards at 30 a minute. The count lives on the token; the slot is taken in the same transaction
-- that creates the card, so a failed creation gives the slot back.

alter table lead_tokens
  add column created_day date,
  add column created_today int not null default 0;

grant select (created_day, created_today), update (created_day, created_today) on lead_tokens to isaac_app;

-- true while the token has a slot left today (UTC day); takes one. Runs as the caller, so row-level security keeps
-- a user to their own tokens.
create function public.lead_token_take_slot(p_token uuid, p_cap int) returns boolean
language plpgsql set search_path = public, pg_temp as $$
declare took int;
begin
  update lead_tokens set
      created_today = case when created_day = current_date then created_today + 1 else 1 end,
      created_day = current_date
   where id = p_token and revoked_at is null
     and (created_day is distinct from current_date or created_today < p_cap);
  get diagnostics took = row_count;
  return took = 1;
end $$;
