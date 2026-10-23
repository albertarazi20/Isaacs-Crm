-- 0210: the three column defaults that still said "today on the server" now say "today for the signed-in user"
-- (review-4 C-11). The functions that write these columns already pass the user's day; this covers a plain insert.
alter table offers alter column received_on set default app.local_today();
alter table submissions alter column sent_on set default app.local_today();
alter table competing_offers alter column offered_on set default app.local_today();
