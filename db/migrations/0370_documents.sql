-- Documents: the merchant's files, per merchant and per deal. Bytes live in object storage (never a column, never
-- git — CLAUDE.md); this holds the pointer, the label, who uploaded it and every view. A received document ticks the
-- matching stip, which re-buckets the merchant and stops the reminders (0320).

-- The merchant's permanent upload link: /upload/<token>. Separate from the unsubscribe token on purpose.
alter table clients add column upload_token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
create unique index clients_upload_token_key on clients (upload_token);

create table documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users (id) on delete cascade,     -- the merchant's rep (RLS key)
  client_id uuid not null,
  deal_id uuid references deals (id) on delete set null,
  kind text not null check (kind in ('signed_application', 'bank_statement', 'drivers_license', 'voided_check',
                                     'proof_of_ownership', 'tax_return', 'lease_letter', 'processing_statement',
                                     'signed_contract', 'funding_agreement', 'offer_sheet', 'other')),
  period date check (period is null or period = date_trunc('month', period)::date),   -- the statement month
  filename text not null check (btrim(filename) <> ''),
  content_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (length(sha256) = 64),
  storage_key text not null unique,
  source text not null check (source in ('upload_link', 'staff', 'email', 'sheet')),
  uploaded_by uuid references app_users (id) on delete set null,          -- staff; null for the merchant
  label_by text not null default 'rule' check (label_by in ('rule', 'ai', 'human')),
  label_confidence numeric(3,2) not null default 0 check (label_confidence between 0 and 1),
  label_reason text not null default '',
  -- nothing downloads until the file is clean. 'pending' is the merchant upload waiting for the scan.
  scan_status text not null default 'pending' check (scan_status in ('pending', 'clean', 'infected', 'rejected')),
  scan_note text not null default '',
  scanned_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references app_users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (client_id, sha256),
  foreign key (client_id, user_id) references clients (id, user_id) on delete cascade
);
create index documents_client_idx on documents (client_id, created_at desc) where deleted_at is null;
create index documents_client_kind_idx on documents (client_id, kind, period) where deleted_at is null;
create index documents_scan_idx on documents (created_at) where scan_status = 'pending';
grant select, insert, update on documents to isaac_app;
alter table documents enable row level security;
create policy documents_owner on documents for all to isaac_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy documents_team on documents for all to isaac_app
  using (app.can_see_all()) with check (app.can_see_all());
create policy documents_ops on documents for select to isaac_app using (app.is_ops_deal(client_id));

create function app.document_label(p_kind text, p_period date) returns text
language sql immutable as $$
  select case p_kind
    when 'signed_application' then 'Signed application'
    when 'bank_statement' then coalesce(to_char(p_period, 'FMMon YYYY') || ' ', '') || 'bank statement'
    when 'drivers_license' then 'Driver''s license / ID'
    when 'voided_check' then 'Voided check'
    when 'proof_of_ownership' then 'Proof of ownership'
    when 'tax_return' then 'Tax return'
    when 'lease_letter' then 'Landlord / lease letter'
    when 'processing_statement' then 'Processing statement'
    when 'signed_contract' then 'Signed contract'
    when 'funding_agreement' then 'Funding agreement'
    when 'offer_sheet' then 'Offer sheet'
    else 'Other document' end
$$;

-- A document that answers a stip ticks it. When the merchant already has a checklist the row joins it as required and
-- received; when they have none, it is recorded as received but not required, so a stray upload does not invent a
-- checklist and march the merchant to "ready for ops".
create function app.file_document(d documents) returns void
language plpgsql set search_path = public, pg_temp as $$
declare has_checklist boolean;
begin
  if d.kind not in ('signed_application', 'bank_statement', 'drivers_license', 'voided_check',
                    'proof_of_ownership', 'tax_return', 'lease_letter', 'processing_statement') then return; end if;
  select exists (select 1 from stips where client_id = d.client_id and required) into has_checklist;
  insert into stips (user_id, client_id, kind, period, required, received_at, doc_key)
  values (d.user_id, d.client_id, d.kind, case when d.kind = 'bank_statement' then d.period end, has_checklist, now(), d.storage_key)
  on conflict (client_id, kind, coalesce(period, date '0001-01-01'))
    do update set received_at = coalesce(stips.received_at, now()), doc_key = excluded.doc_key;
end $$;

create function app.document_inserted() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  perform app.file_document(new);
  insert into activities (user_id, client_id, kind, body)
  values (new.user_id, new.client_id, 'system',
          'Received ' || app.document_label(new.kind, new.period) || ' — ' || new.filename ||
          case new.source when 'upload_link' then ' (merchant upload)' when 'email' then ' (from email)' when 'sheet' then ' (from the sheet)' else '' end);
  return new;
end $$;
create trigger documents_filed after insert on documents for each row execute function app.document_inserted();

-- A rep corrects the label; the checklist follows.
create function public.relabel_document(p_doc uuid, p_kind text, p_period date)
returns documents
language plpgsql set search_path = public, pg_temp as $$
declare d documents;
begin
  update documents set kind = p_kind, period = case when p_kind = 'bank_statement' then p_period end,
                       label_by = 'human', label_confidence = 1, label_reason = 'set by ' || coalesce((select name from app_users where id = app.current_user_id()), 'staff')
   where id = p_doc and deleted_at is null returning * into d;
  if not found then raise exception 'document not found' using errcode = 'P0002'; end if;
  perform app.file_document(d);
  return d;
end $$;

-- Upload sessions: a short-lived (2h) token behind every upload. The merchant's permanent link mints one on open;
-- a rep mints one for "text me the link". `wanted` is what we are asking for, so the page can say it.
create table upload_sessions (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  client_id uuid not null references clients (id) on delete cascade,
  deal_id uuid references deals (id) on delete set null,
  purpose text not null default 'documents' check (purpose in ('documents', 'statements', 'stips', 'application', 'renewal')),
  wanted jsonb not null default '[]'::jsonb,
  created_by uuid references app_users (id) on delete set null,          -- null: the merchant opened their own link
  expires_at timestamptz not null,
  max_files int not null default 20 check (max_files between 1 and 100),
  files_received int not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index upload_sessions_client_idx on upload_sessions (client_id, created_at desc);
grant select, insert, update on upload_sessions to isaac_app;
alter table upload_sessions enable row level security;
-- visible to whoever can see the merchant (the clients policies decide)
create policy upload_sessions_by_client on upload_sessions for all to isaac_app
  using (exists (select 1 from clients c where c.id = client_id))
  with check (exists (select 1 from clients c where c.id = client_id));

-- Every view, download and lender copy, with who and from where (plan: "every view logged").
create table document_views (
  id bigint generated always as identity primary key,
  document_id uuid not null references documents (id) on delete cascade,
  action text not null check (action in ('view', 'download', 'link_minted', 'lender_download', 'relabel', 'delete')),
  viewer_user_id uuid references app_users (id) on delete set null,
  link_id uuid,
  lender_id uuid references funders (id) on delete set null,
  ip text not null default '',
  user_agent text not null default '',
  at timestamptz not null default now()
);
create index document_views_doc_idx on document_views (document_id, at desc);
create index document_views_user_idx on document_views (viewer_user_id, at desc);
grant select, insert on document_views to isaac_app;
alter table document_views enable row level security;
create policy document_views_read on document_views for select to isaac_app
  using (exists (select 1 from documents d where d.id = document_id));
create policy document_views_write on document_views for insert to isaac_app with check (true);

-- Expiring download links for a lender (or anyone outside the app). The copy they get is watermarked with their name.
create table document_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  document_id uuid not null references documents (id) on delete cascade,
  created_by uuid references app_users (id) on delete set null,
  lender_id uuid references funders (id) on delete set null,
  watermark text not null default '',
  expires_at timestamptz not null,
  max_downloads int not null default 5 check (max_downloads between 1 and 100),
  downloads int not null default 0,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index document_links_doc_idx on document_links (document_id, created_at desc);
grant select, insert, update on document_links to isaac_app;
alter table document_links enable row level security;
create policy document_links_by_doc on document_links for all to isaac_app
  using (exists (select 1 from documents d where d.id = document_id))
  with check (exists (select 1 from documents d where d.id = document_id));
