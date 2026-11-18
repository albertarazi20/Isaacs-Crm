-- 0564: closes the gaps the app role could reach through helpers and wide grants (review findings database-5, -6).

-- 1. The AI spend cap sums ai_runs.cost_cents; a negative cost logged through the helper cancelled real spend.
--    Costs can only be zero or more, and the helper clamps what it is given (it never raises: the audit line must
--    always be written).
update ai_runs set cost_cents = 0 where cost_cents < 0;
alter table ai_runs add constraint ai_runs_cost_nonnegative check (cost_cents is null or cost_cents >= 0);
create or replace function app.log_ai_run(p_purpose text, p_model text, p_prompt_version text, p_input_hash text,
                                          p_input_tokens int, p_output_tokens int, p_cost_cents numeric, p_output jsonb, p_error text)
returns uuid
language sql security definer set search_path = public, pg_temp as $$
  insert into ai_runs (purpose, model, prompt_version, input_hash, input_tokens, output_tokens, cost_cents, output, error)
  values (p_purpose, p_model, p_prompt_version, p_input_hash, p_input_tokens, p_output_tokens,
          greatest(coalesce(p_cost_cents, 0), 0), p_output, p_error)
  returning id
$$;

-- 2. app.suppress runs as the owner. A signed-in rep may only suppress through a merchant they can touch (what opt_out
--    does for them), recorded under their own name; the system (no signed-in user) and managers are unrestricted.
create or replace function app.suppress(p_channel text, p_key_hash text, p_display text, p_reason text, p_note text, p_client uuid, p_by uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if app.current_user_id() is not null and not app.can_see_all() then
    if p_client is null or not app.can_touch_client(p_client) then
      raise exception 'merchant not found' using errcode = 'P0002';
    end if;
    if p_by is not null and p_by is distinct from app.current_user_id() then
      raise exception 'a suppression is recorded under your own name' using errcode = '42501';
    end if;
  end if;
  insert into suppressions (channel, key_hash, display, reason, note, client_id, created_by)
  values (p_channel, p_key_hash, p_display, p_reason, coalesce(p_note, ''), p_client, p_by)
  on conflict (channel, key_hash) do nothing;
end $$;

-- 3. An alert's link is an in-app path. Anything else (a full URL, //host) would put a link of someone's choosing in
--    front of a manager. NOT VALID: rows written before this stay as they are, every new row is checked.
alter table user_alerts add constraint user_alerts_href_in_app check (href = '' or href ~ '^/([^/\\].*)?$') not valid;

-- 4. Scan results are the scanner's alone. The app role changed any column of a document, so a rep session could mark
--    a file the scanner rejected as clean. It keeps what reps really do: relabel, attach to a deal, delete.
revoke update on documents from isaac_app;
grant update (kind, period, deal_id, label_by, label_confidence, label_reason, deleted_at, deleted_by) on documents to isaac_app;
