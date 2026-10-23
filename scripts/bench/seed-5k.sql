begin;
insert into app_users (email, name, timezone) values ('perf5k@example.com', 'Perf', 'America/New_York') on conflict (email) do nothing;
with u as (select id from app_users where email = 'perf5k@example.com'),
stages as (select array['name_in','spoke_with_owner','interested','call_scheduled','application_sent','application_in','stips','submitted','offers_in','offer_presented','contract_out','funded','paying_off_soon','paid_in_full','default_workable','default_bad','declined','lost','killed','dead','not_interested'] as s)
insert into clients (id, user_id, business_name, contact_name, phone, email, industry, state, source, stage, created_at)
select gen_random_uuid(), u.id, 'Perf Biz ' || g, 'Owner ' || g, '+1305' || lpad((5550000 + g)::text, 7, '0'), 'o' || g || '@perf.example',
       (array['Restaurant','Trucking','Retail','Auto repair','Salon'])[1 + g % 5], (array['TX','FL','NY','CA'])[1 + g % 4],
       (array['Referral','Lead list A','Website','Cold call'])[1 + g % 4], stages.s[1 + g % 21], now() - (g % 400 || ' days')::interval
from u, stages, generate_series(1, 5000) g;
insert into timers (user_id, client_id, kind, due_on, created_at, done_at, done_reason)
select c.user_id, c.id, 'follow_up', current_date + ((row_number() over (order by c.id)) % 330)::int - 40, c.created_at, null, null
from clients c where c.user_id = (select id from app_users where email = 'perf5k@example.com');
-- closed history timers: ~3 per client so the discipline query has real volume
insert into timers (user_id, client_id, kind, due_on, created_at, done_at, done_reason)
select c.user_id, c.id, 'follow_up', current_date - (i * 9 + (row_number() over (partition by i order by c.id)) % 7)::int, now() - interval '200 days',
       now() - (i * 9 || ' days')::interval, (array['completed','replaced','stage_moved'])[1 + i % 3]
from clients c, generate_series(1, 3) i where c.user_id = (select id from app_users where email = 'perf5k@example.com');
insert into activities (user_id, client_id, kind, body, occurred_at, to_stage)
select c.user_id, c.id, 'system', 'Client added', c.created_at, c.stage from clients c where c.user_id = (select id from app_users where email = 'perf5k@example.com');
insert into activities (user_id, client_id, kind, body, occurred_at)
select c.user_id, c.id, 'note', 'note ' || i, now() - (i * 11 || ' days')::interval from clients c, generate_series(1, 5) i where c.user_id = (select id from app_users where email = 'perf5k@example.com');
insert into client_asks (user_id, client_id, wanted_amount_cents)
select c.user_id, c.id, (20 + (row_number() over (order by c.id)) % 180) * 100000 from clients c where c.user_id = (select id from app_users where email = 'perf5k@example.com');
insert into fundings (user_id, client_id, funded_on, funder_name, amount_cents, factor_rate, payment_cents, frequency, commission_cents)
select c.user_id, c.id, current_date - ((row_number() over (order by c.id)) % 300)::int, 'Alpha', 3000000 + (row_number() over (order by c.id)) % 50 * 100000, 1.3, 40000, 'daily', 200000
from clients c where c.user_id = (select id from app_users where email = 'perf5k@example.com') and c.stage in ('funded','paying_off_soon','paid_in_full','default_workable','default_bad');
commit;
select count(*) as clients from clients where user_id = (select id from app_users where email = 'perf5k@example.com');
select count(*) as timers from timers where user_id = (select id from app_users where email = 'perf5k@example.com');
select count(*) as fundings from fundings where user_id = (select id from app_users where email = 'perf5k@example.com');
