-- An instant email when a lead arrives through lead intake. It uses the same claim-then-send table as the
-- digest and call reminders, so a retry can never send the same lead's alert twice.
alter table reminders_sent drop constraint reminders_sent_kind_check;
alter table reminders_sent add constraint reminders_sent_kind_check check (kind in ('digest', 'call', 'new_lead'));
