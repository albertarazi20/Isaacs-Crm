-- The "opened but did not finish" nudge. A merchant who opens their upload link or their application (link_opens,
-- 0547) and has not finished a day later gets one short email with the link again, then nothing more for a week.
-- Off until a manager switches it on in Settings > Email; the two emails are ordinary shop templates, so they can be
-- edited, paused or archived like any other (an archived or paused one is simply not sent).
-- src/lib/system/openNudge.ts picks the merchants and queues the email; the hourly cron runs it.

alter table shop_settings
  add column open_nudge boolean not null default false,
  add column open_nudge_upload_template uuid references templates (id) on delete set null,
  add column open_nudge_apply_template uuid references templates (id) on delete set null;

with up as (
  insert into templates (owner_id, name, subject, body, approved)
  values (null, 'Nudge: finish uploading', 'Your link to finish up, {first_name}',
          E'Hi {first_name},\n\nI saw you started sending your documents for {business}. Here is your link again so you can pick up where you left off:\n\n{upload_link}\n\nIt only takes a couple of minutes, and photos from your phone are fine. If anything is in the way, just reply and I will help.',
          true)
  returning id),
ap as (
  insert into templates (owner_id, name, subject, body, approved)
  values (null, 'Nudge: finish the application', 'Your application is almost done, {first_name}',
          E'Hi {first_name},\n\nI saw you opened the application for {business}. Here is the link again so you can finish it:\n\n{application_link}\n\nIt takes a few minutes. If a question is unclear, just reply and I will walk you through it.',
          true)
  returning id)
update shop_settings set open_nudge_upload_template = (select id from up),
                         open_nudge_apply_template = (select id from ap);
