-- The assistant's time limit (src/lib/assistant/run.ts): a model call still running near the end of a hosted
-- request (60 s) is stopped and run again by the browser's continue. assistant_threads.timeouts counts those stops
-- in a row for a conversation: after one the next try uses less effort, after two the person is told to ask for a
-- shorter answer instead of the call being repeated (and paid for) again. A call that finishes resets it.
alter table assistant_threads add column timeouts int not null default 0 check (timeouts >= 0);
