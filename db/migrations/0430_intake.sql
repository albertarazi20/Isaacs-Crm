-- The intake form's extra fields (plan §4): a second phone and email, and "what are they looking for" in the
-- merchant's own words. The sheet rows already carry phone2/email2 (0330); the merchant row now keeps them.
alter table clients
  add column phone2 text not null default '',
  add column email2 text not null default '',
  add column looking_for text not null default '';
