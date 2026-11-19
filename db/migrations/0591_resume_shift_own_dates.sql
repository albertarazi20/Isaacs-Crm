-- 0591: a pause that sets its own dates must not also be shifted on resume (review of 0583).
-- 0583 moves a resumed enrolment's next due day and entry time forward by the days it was paused, and stamps paused_at
-- when a rep pauses. A merchant's "not now" reply sets its own revive dates on the SAME row (paused stays true, next_due_on
-- and entered_at jump to the revive day) but never cleared paused_at, so when the engine lifted that pause on the revive
-- day the trigger added the length of an earlier manual pause on top of it: a rep pause on Nov 1, "not now" on Nov 10
-- (revive Dec 10) resumed on Jan 18. Now any update that keeps the row paused but moves its dates FORWARD (a revive day is always in the future) clears paused_at,
-- so only a plain manual pause is shifted.
create or replace function app.enrollment_resume_shift() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare days int;
begin
  if old.paused and new.paused
     and (new.next_due_on > old.next_due_on or new.entered_at > old.entered_at) then
    new.paused_at := null;
  end if;
  if old.paused and not new.paused then
    if old.paused_at is not null then
      days := greatest(0, floor(extract(epoch from (now() - old.paused_at)) / 86400))::int;
      if days > 0 then
        if new.next_due_on is not null and new.next_due_on is not distinct from old.next_due_on then
          new.next_due_on := new.next_due_on + days;
        end if;
        if new.entered_at is not distinct from old.entered_at then
          new.entered_at := new.entered_at + make_interval(days => days);
        end if;
      end if;
    end if;
    new.paused_at := null;
  end if;
  return new;
end $$;
