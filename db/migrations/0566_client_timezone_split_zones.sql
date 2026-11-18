-- 0566: a merchant's time zone uses the area code where the state spans two zones (review finding database-8).
-- 0310 chose manual > state > area code, but a state maps to one zone: a Pensacola merchant (FL, 850) was treated as
-- Eastern although 850 is Central, so the send window and every "today" were an hour off; El Paso (TX, 915) the same.
-- Now, for a state that spans zones, an area code in one of that state's zones wins; otherwise the state decides as
-- before (a Texas address with a New York cell number is still Texas).
create or replace function app.client_timezone(c clients) returns text
language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    c.timezone,
    (select a.tz
       from area_code_tz a
       join (values
         ('FL', array['America/New_York', 'America/Chicago']),
         ('TX', array['America/Chicago', 'America/Denver']),
         ('KY', array['America/New_York', 'America/Chicago', 'America/Kentucky/Louisville']),
         ('TN', array['America/New_York', 'America/Chicago']),
         ('ID', array['America/Boise', 'America/Los_Angeles']),
         ('OR', array['America/Los_Angeles', 'America/Boise']),
         ('KS', array['America/Chicago', 'America/Denver']),
         ('NE', array['America/Chicago', 'America/Denver']),
         ('SD', array['America/Chicago', 'America/Denver']),
         ('ND', array['America/Chicago', 'America/Denver']),
         ('MI', array['America/Detroit', 'America/Chicago']),
         ('IN', array['America/Indiana/Indianapolis', 'America/Chicago', 'America/New_York'])
       ) as split(st, zones) on split.st = upper(btrim(c.state))
      where a.code = substr(regexp_replace(c.phone, '\D', '', 'g'), case when length(regexp_replace(c.phone, '\D', '', 'g')) = 11 then 2 else 1 end, 3)
        and a.tz = any (split.zones)),
    (select tz from app_state_tz where state = upper(btrim(c.state))),
    (select tz from area_code_tz where code = substr(regexp_replace(c.phone, '\D', '', 'g'), case when length(regexp_replace(c.phone, '\D', '', 'g')) = 11 then 2 else 1 end, 3)),
    (select timezone from app_users where id = c.user_id),
    'America/New_York')
$$;
