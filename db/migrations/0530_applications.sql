-- The application the merchant signs in the app (plan §13.5 "the merchant sees and signs their own application",
-- §7 Documents), and a definer helper so the app role can log an AI run it made on a person's behalf.

-- ---------- the merchant's application link ----------
-- A permanent secret per merchant, like upload_token: the email merge field {application_link} uses it when the rep
-- has no outside form of their own.
alter table clients add column application_token text not null
  default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
create unique index clients_application_token_key on clients (application_token);

-- ---------- signed applications ----------
create table applications (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  user_id uuid not null references app_users (id) on delete cascade,     -- the merchant's rep at signing time
  deal_id uuid references deals (id) on delete set null,
  document_id uuid references documents (id) on delete set null,        -- the PDF, kind signed_application
  fields jsonb not null,                                                 -- what the merchant typed (no SSN, EIN last four only)
  signer_name text not null check (btrim(signer_name) <> ''),
  signed_at timestamptz not null default now(),
  ip text not null default '',
  user_agent text not null default '',
  consent_email boolean not null default false,
  consent_sms boolean not null default false
);
create index applications_client_idx on applications (client_id, signed_at desc);
grant select on applications to isaac_app;
alter table applications enable row level security;
create policy applications_owner on applications for select to isaac_app
  using (user_id = app.current_user_id() or app.can_see_all()
         or exists (select 1 from clients c where c.id = applications.client_id));

-- ---------- an AI run made for a person ----------
-- ai_runs is owner-only (0340); the lender reader logs through the system connection and the pasted-text importer
-- through record_pasted_read. Deal questions and screenshot transcriptions run as the person, so they log here.
create function public.record_ai_run(p_purpose text, p_deal uuid, p_run jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_purpose not in ('ask_deal', 'transcribe_offer_image') then
    raise exception 'unknown AI purpose %', p_purpose using errcode = '22023';
  end if;
  if p_deal is not null and not exists (select 1 from deals where id = p_deal) then
    raise exception 'deal not found' using errcode = 'P0002';
  end if;
  insert into ai_runs (purpose, model, prompt_version, input_hash, input_tokens, output_tokens, cost_cents, output, error, deal_id)
  values (p_purpose, p_run->>'model', p_run->>'prompt_version', coalesce(p_run->>'input_hash', 'n/a'),
          (p_run->>'input_tokens')::int, (p_run->>'output_tokens')::int, (p_run->>'cost_cents')::numeric,
          p_run->'output', p_run->>'error', p_deal)
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.record_ai_run(text, uuid, jsonb) from public;
grant execute on function public.record_ai_run(text, uuid, jsonb) to isaac_app;
