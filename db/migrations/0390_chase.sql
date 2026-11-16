-- The lender chase rule lives in Settings, not in code: how many quiet days before a nudge, and whether it sends.
alter table shop_settings
  add column lender_chase_days int not null default 3 check (lender_chase_days between 1 and 14),
  add column lender_chase_mode text not null default 'send' check (lender_chase_mode in ('send', 'off')),
  add column lender_chase_max int not null default 2 check (lender_chase_max between 0 and 5);
