-- 0170: a merchant in the trash can't have his advance, submissions or offers edited from a stale tab (review-3A A-13).
-- timers already refuse this (timers_live_only, 0090). Deletes are left alone on purpose: purging a merchant removes
-- these rows by cascade, and that is the one thing that is meant to work on a trashed merchant.

create function app.refuse_when_trashed() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (select 1 from trashed_clients t where t.client_id = new.client_id) then
    raise exception 'That merchant is in the trash — restore it first' using errcode = '22023';
  end if;
  return new;
end $$;

create trigger fundings_live_only before insert or update on fundings
  for each row execute function app.refuse_when_trashed();
create trigger submissions_live_only before insert or update on submissions
  for each row execute function app.refuse_when_trashed();
create trigger offers_live_only before insert or update on offers
  for each row execute function app.refuse_when_trashed();
