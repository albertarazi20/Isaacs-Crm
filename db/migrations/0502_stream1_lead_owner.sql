-- Stream 1, S1-3: the cross-rep duplicate block. Row security hides another rep's merchants, so a rep typing a phone
-- another rep already owns used to get a second merchant row (plan §4.3). lead_owner answers "whose is it?" across
-- every rep for one phone or email: the owner, the bucket (or stage) and the last touch, and nothing else — no
-- contact details leave the other rep's book. Intake and sheet filing refuse the rep with that answer in words;
-- a manager, who sees every row anyway, gets the ordinary duplicate outcome.

create function public.lead_owner(p_phone text, p_email text)
returns table (
  client_id uuid,
  owner_id uuid,
  owner_name text,
  owner_email text,
  business_name text,
  bucket_name text,
  stage text,
  last_touch_at timestamptz,
  matched_on text
)
language sql stable security definer set search_path = public, pg_temp as $$
  with want as (
    select nullif(right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10), '') as digits,
           nullif(lower(btrim(coalesce(p_email, ''))), '') as email
  )
  select c.id, c.user_id, u.name, u.email, c.business_name,
         (select b.name from enrollments e join buckets b on b.id = e.bucket_id
           where e.client_id = c.id and e.stopped_at is null order by e.entered_at desc limit 1),
         c.stage,
         (select max(a.occurred_at) from activities a where a.client_id = c.id),
         case when w.digits is not null and length(w.digits) = 10
                   and right(regexp_replace(c.phone, '\D', '', 'g'), 10) = w.digits then 'phone' else 'email' end
    from clients c join app_users u on u.id = c.user_id, want w
   where (c.contact_status <> 'ok' or not exists (select 1 from trashed_clients t where t.client_id = c.id))
     and ((w.digits is not null and length(w.digits) = 10 and right(regexp_replace(c.phone, '\D', '', 'g'), 10) = w.digits)
       or (w.email is not null and (lower(c.email) = w.email or lower(c.email2) = w.email)))
   order by case when w.digits is not null and right(regexp_replace(c.phone, '\D', '', 'g'), 10) = w.digits then 0 else 1 end,
            c.created_at
   limit 1
$$;
revoke execute on function public.lead_owner(text, text) from public;
grant execute on function public.lead_owner(text, text) to isaac_app;
