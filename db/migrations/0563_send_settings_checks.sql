-- 0563: the send window and the daily caps are checked as a set (review finding database-3).
-- Each setting had its own range check, but nothing tied them together: a window with start >= end (17 to 9, or 10 to
-- 10) is never open, so every sequence, blast and nudge email is pushed another 24 hours forever, with no error; a
-- reserve for intake at or above the daily cap, or an amber line above it, leaves the sequences no room at all.
-- Rows that already break a rule are put back to a sane value first so the migration cannot fail on live data.
update shop_settings set send_window_start = 9, send_window_end = 11 where send_window_start >= send_window_end;
update shop_settings set reserved_for_intake = daily_cap - 1 where reserved_for_intake >= daily_cap;
update shop_settings set amber_at = daily_cap where amber_at > daily_cap;
alter table shop_settings
  add constraint shop_settings_send_window_check check (send_window_start < send_window_end),
  add constraint shop_settings_reserve_below_cap_check check (reserved_for_intake < daily_cap),
  add constraint shop_settings_amber_within_cap_check check (amber_at <= daily_cap);
