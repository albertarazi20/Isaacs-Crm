-- A Monday email: how last week went. Same claim-then-send table as the other reminder emails, so a retry
-- or two overlapping hourly runs can never send one twice.
alter table reminders_sent drop constraint reminders_sent_kind_check;
alter table reminders_sent add constraint reminders_sent_kind_check
  check (kind in ('digest', 'call', 'new_lead', 'weekly'));
