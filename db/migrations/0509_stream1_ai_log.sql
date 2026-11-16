-- Stream 1, S1-12: the paste-a-lead-line splitter runs from a signed-in user's action, not a job, and the app role may
-- only read ai_runs. One owner-side helper writes the audit line (model, cost, output) so the spend cap and the audit
-- see every call, whoever made it.
create function app.log_ai_run(p_purpose text, p_model text, p_prompt_version text, p_input_hash text,
                               p_input_tokens int, p_output_tokens int, p_cost_cents numeric, p_output jsonb, p_error text)
returns uuid
language sql security definer set search_path = public, pg_temp as $$
  insert into ai_runs (purpose, model, prompt_version, input_hash, input_tokens, output_tokens, cost_cents, output, error)
  values (p_purpose, p_model, p_prompt_version, p_input_hash, p_input_tokens, p_output_tokens, p_cost_cents, p_output, p_error)
  returning id
$$;
revoke execute on function app.log_ai_run(text, text, text, text, int, int, numeric, jsonb, text) from public;
grant execute on function app.log_ai_run(text, text, text, text, int, int, numeric, jsonb, text) to isaac_app;
