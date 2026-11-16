-- Stream 2 (S2-8): the double-submission guard. The same merchant to the same lender twice inside the shop's window
-- is a double submission whoever sends it: lenders flag a file that arrives from two desks, and a second rep working
-- the same owner (the same phone or email, under another merchant row) is how a backdoor starts. The check runs as
-- the owner so it sees every rep's rows; create_submissions refuses with the lender's name and the date it last went.
-- `p_force` sends anyway on purpose, written on the timeline (like the shotgun override).

create function app.recent_submission_elsewhere(p_client uuid, p_funder_ids uuid[], p_sent date, p_days int)
returns table (funder_id uuid, funder_name text, sent_on date, rep_name text, business_name text)
language sql stable security definer set search_path = public, pg_temp as $$
  with me as (
    select regexp_replace(c.phone, '\D', '', 'g') as phone_digits,
           case when c.email <> '' then app.suppression_key(c.email) end as email_key
      from clients c where c.id = p_client
  ),
  twins as (
    select c.id from clients c, me
     where c.id = p_client
        or (me.phone_digits <> '' and app.suppression_key(regexp_replace(c.phone, '\D', '', 'g')) = app.suppression_key(me.phone_digits))
        or (me.email_key is not null and c.email <> '' and app.suppression_key(c.email) = me.email_key)
  )
  select distinct on (s.funder_id) s.funder_id, f.name, s.sent_on,
         coalesce(nullif(u.name, ''), u.email), c.business_name
    from submissions s
    join twins t on t.id = s.client_id
    join funders f on f.id = s.funder_id
    join clients c on c.id = s.client_id
    join app_users u on u.id = s.user_id
   where s.funder_id = any(p_funder_ids) and abs(s.sent_on - p_sent) < p_days
   order by s.funder_id, s.sent_on desc
$$;
revoke execute on function app.recent_submission_elsewhere(uuid, uuid[], date, int) from public;
grant execute on function app.recent_submission_elsewhere(uuid, uuid[], date, int) to isaac_app;

-- The signature gains p_force; the old one goes so a four-argument call is never ambiguous.
drop function public.create_submissions(uuid, uuid[], date, text);

create function public.create_submissions(p_client uuid, p_funder_ids uuid[], p_sent_on date default null,
                                          p_note text default '', p_force boolean default false)
returns setof submissions
language plpgsql set search_path = public, pg_temp as $$
declare
  c clients;
  sent date := coalesce(p_sent_on, app.local_today());
  ids uuid[];
  new_ids uuid[];
  names text;
  v_note text := btrim(coalesce(p_note, ''));
  v_days int;
  seen record;
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(distinct x), '{}') into ids from unnest(p_funder_ids) x where x is not null;
  if cardinality(ids) = 0 then
    raise exception 'pick at least one funder' using errcode = '22023';
  end if;
  if cardinality(ids) > 50 then
    raise exception 'send to 50 funders or fewer at a time' using errcode = '22023';
  end if;
  -- ±1 day of slack: the database clock is UTC, Isaac's calendar is not.
  if sent > app.local_today() + 1 then
    raise exception 'the sent date % is in the future', sent using errcode = '22023';
  end if;
  if sent < app.local_today() - 365 then
    raise exception 'the sent date % is more than a year ago', sent using errcode = '22023';
  end if;
  -- RLS hides other users' funders, so a foreign id is simply "not found".
  if (select count(*) from funders where id = any(ids)) <> cardinality(ids) then
    raise exception 'funder not found' using errcode = 'P0002';
  end if;
  select string_agg(name, ', ' order by lower(name)) into names from funders where id = any(ids) and not active;
  if names is not null then
    raise exception '% is archived — restore it on the Funders page first', names using errcode = '22023';
  end if;
  select string_agg(f.name, ', ' order by lower(f.name)) into names
    from submissions s join funders f on f.id = s.funder_id
   where s.client_id = p_client and s.funder_id = any(ids) and s.sent_on = sent;
  if names is not null then
    raise exception 'Already sent to % on %', names, to_char(sent, 'FMMon FMDD') using errcode = '22023';
  end if;

  -- the shop's window: the same owner (this row, or another rep's row with the same phone or email) and the same
  -- lender within N days is a double submission
  v_days := coalesce((select resubmit_block_days from shop_settings), 30);
  if v_days > 0 then
    select * into seen from app.recent_submission_elsewhere(p_client, ids, sent, v_days) order by sent_on desc limit 1;
    if found then
      if not p_force then
        raise exception '% already went to % on % (%''s file: %) — the shop waits % days before the same lender sees a merchant again',
          c.business_name, seen.funder_name, to_char(seen.sent_on, 'FMMon FMDD'), seen.rep_name, seen.business_name, v_days
          using errcode = '22023';
      end if;
      insert into activities (user_id, client_id, kind, body)
      values (c.user_id, p_client, 'system',
              'Resubmission override: ' || seen.funder_name || ' saw this merchant on ' || to_char(seen.sent_on, 'FMMon FMDD') ||
              ' (' || seen.rep_name || '''s file)');
    end if;
  end if;

  with ins as (
    insert into submissions (user_id, client_id, funder_id, sent_on, note)
    select c.user_id, p_client, f.id, sent, v_note from funders f where f.id = any(ids)
    returning id
  )
  select array_agg(id) into new_ids from ins;

  select string_agg(f.name, ', ' order by lower(f.name)) into names from funders f where f.id = any(ids);
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Submitted to ' || names || case when v_note <> '' then ' — ' || v_note else '' end);

  -- Application in / Collecting stips -> Submitted to funders. This closes every open timer, so the
  -- chase timers are created AFTER it.
  if c.stage in ('application_in', 'stips') then
    perform app.move_keeping_chase(p_client, 'submitted',
      jsonb_build_array(jsonb_build_object('kind', 'follow_up', 'due_on', app.add_business_days(app.local_today(), 1), 'note', '')),
      '');
  end if;

  insert into timers (user_id, client_id, kind, due_on, note, submission_id)
  select c.user_id, p_client, 'chase', app.add_business_days(sent, 1), 'Ask ' || f.name || ' for a decision', s.id
    from submissions s join funders f on f.id = s.funder_id
   where s.id = any(new_ids)
   order by lower(f.name);

  -- the lenders have the file: the deal leaves the ops queue (P2-42)
  update deals set ops_status = 'sent', sent_at = coalesce(sent_at, now()), blocker = ''
   where client_id = p_client and outcome = 'open' and ops_status in ('queued', 'kicked_back');

  return query
    select s.* from submissions s join funders f on f.id = s.funder_id
     where s.id = any(new_ids) order by lower(f.name);
end $$;
