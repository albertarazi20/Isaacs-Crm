-- Stream 3 renewals (docs/AUTOMATION-AUDIT.md S3-4): the two automated emails of the renewal engine as shared,
-- approved templates (the job in src/lib/money/renewals.ts sends them through the outbox and stamps the funding),
-- and start_renewal, which opens the renewal deal pre-filled from the funding and asks the merchant for the newest
-- statement through the bucket that already knows how.

alter table fundings
  add column renewal_warm_sent_at timestamptz,
  add column renewal_eligible_sent_at timestamptz;

insert into templates (owner_id, name, subject, body, approved) values
  (null, 'Renewal — warm-up', 'Good progress on {business}''s advance',
   'Hi {first_name},' || E'\n\n' || 'You are about 40% of the way through the advance for {business}. Merchants who keep paying on time usually qualify for more funds once they are about half paid, often on better terms.' || E'\n\n' || 'If capital would help in the next few weeks, reply here and I will start the numbers.', true),
  (null, 'Renewal — eligible', '{business} is eligible for more funds',
   'Hi {first_name},' || E'\n\n' || 'Good news: {business} has paid enough of the current advance to qualify for more funds. To get numbers back, lenders need your newest bank statement. Upload it here: {upload_link}' || E'\n\n' || 'Reply with any questions.', true);

-- Open the renewal deal from a funding: one open deal per merchant, the terms copied into the rep note, the newest
-- statement asked for (the stips trigger moves the merchant into "Need newest statement"), the renewal task done.
create function public.start_renewal(p_funding uuid)
returns deals
language plpgsql security definer set search_path = public, pg_temp as $$
declare f fundings; c clients; d deals; me uuid := app.current_user_id(); b uuid;
        newest date := date_trunc('month', current_date)::date;
begin
  select * into f from fundings where id = p_funding;
  if not found then raise exception 'funding not found' using errcode = 'P0002'; end if;
  select * into c from clients where id = f.client_id for update;
  if me is not null and not (c.user_id = me or app.can_see_all()) then
    raise exception 'that merchant is not yours' using errcode = '22023';
  end if;
  if exists (select 1 from trashed_clients where client_id = c.id) then
    raise exception 'this merchant is in the trash' using errcode = '22023';
  end if;
  if exists (select 1 from deals where client_id = c.id and outcome = 'open') then
    raise exception 'This merchant already has an open deal' using errcode = '22023';
  end if;
  insert into deals (user_id, client_id, kind, requested_cents, use_of_funds, rep_note, blocker)
  values (c.user_id, c.id, 'renewal', f.amount_cents,
          'Renewal of the ' || coalesce(nullif(f.funder_name, ''), 'current') || ' advance',
          'Renewal of ' || app.fmt_money(f.amount_cents) || ' at ' || trim(trailing '.' from to_char(f.factor_rate, 'FM0.999')) ||
            ' funded ' || to_char(f.funded_on, 'Mon DD, YYYY') || ', ' || f.frequency || ' ' || app.fmt_money(f.payment_cents) ||
            case when f.term_days is not null then ', ' || f.term_days || ' days' else '' end,
          'Waiting on the newest bank statement')
  returning * into d;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'system', 'Renewal started from the ' || coalesce(nullif(f.funder_name, ''), 'current') || ' advance as deal D-' || d.number);
  -- the newest statement is the one stip a renewal needs; the checklist trigger moves the merchant to the bucket that asks for it
  insert into stips (user_id, client_id, kind, period, required)
  values (c.user_id, c.id, 'bank_statement', newest, true)
  on conflict (client_id, kind, coalesce(period, date '0001-01-01')) do update set required = true;
  select id into b from buckets where key = 'missing_newest';
  if b is not null and not exists (select 1 from enrollments e where e.client_id = c.id and e.stopped_at is null) then
    perform enroll_in_bucket(c.id, b, 'moved');
  end if;
  update timers set done_at = now(), done_reason = 'completed'
   where client_id = c.id and kind = 'renewal' and done_at is null;
  return d;
end $$;
revoke execute on function public.start_renewal(uuid) from public;
grant execute on function public.start_renewal(uuid) to isaac_app;
