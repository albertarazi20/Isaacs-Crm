-- 0577: a file is only openable once it is scanned (scan_status = 'clean'), and since 0564 only the scanner can write
-- that: UPDATE of the scan columns is revoked from the app role. INSERT was still wide open, and row security checks
-- nothing but user_id, so a rep-role statement could simply insert a row that was already 'clean' (or point a new row's
-- storage_key at another merchant's file) and skip the scan.
--
-- The guard is a trigger on INSERT, for the app role only. The system connection (the merchant's upload, an email
-- attachment, the app's own signed-application PDF) is the table owner, not isaac_app, so it is untouched and keeps
-- writing its own scan result. A row a signed-in person inserts always starts 'pending' with no scan record, and has to
-- sit under its own merchant's folder in storage (the app writes every key as <client id>/<file id>-<name>).
--
-- Safe on a database with rows: existing rows and their scan results are not touched; the trigger only sees new
-- inserts. Creating it takes a brief lock on documents and can run again.
create or replace function app.documents_insert_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user = 'isaac_app' then
    new.scan_status := 'pending';
    new.scan_note := '';
    new.scanned_at := null;
    if new.storage_key is null or left(new.storage_key, 37) <> new.client_id::text || '/' then
      raise exception 'a document is stored under its own merchant' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create or replace trigger documents_insert_guard before insert on documents
  for each row execute function app.documents_insert_guard();
