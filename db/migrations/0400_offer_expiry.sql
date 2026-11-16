-- An approval has a shelf life. The lender row carries it (approval_expires_on, 0300); the offer row gets its own so a
-- revised offer can expire on a different day than the first.
alter table offers add column if not exists expires_on date;
