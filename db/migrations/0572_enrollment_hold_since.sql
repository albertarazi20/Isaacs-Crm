-- When the step an enrolment is on was first held back (a template that cannot send, a merge field that does not exist).
-- The hold limit counts from this moment. It is set when a hold starts and cleared when the step goes out or the
-- sequence moves on, so an old hold that was resolved never shortens a new one on the same repeating step.
-- Nullable, no backfill: a row with no value is simply not being held.
alter table enrollments add column hold_since timestamptz;
