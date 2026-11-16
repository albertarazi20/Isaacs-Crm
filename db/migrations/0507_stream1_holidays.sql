-- Stream 1, S1-11: the send window skips US federal holidays unless the shop says otherwise (plan §5.7). The
-- calendar itself is computed in code (src/lib/send/rules.ts); this is the switch, off by default like weekends.
alter table shop_settings add column send_on_holidays boolean not null default false;
