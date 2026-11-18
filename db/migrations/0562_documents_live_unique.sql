-- 0562: a deleted file no longer blocks uploading the same file again (review finding database-2).
-- documents were unique on (client_id, sha256) over every row, but the app deletes softly (deleted_at) and its own
-- duplicate check only looks at live rows. Deleting a wrong or mislabelled file and then re-sending the same PDF
-- therefore hit the constraint after the blob was stored, and the merchant saw a generic upload error. Uniqueness now
-- applies to live documents only.
alter table documents drop constraint documents_client_id_sha256_key;
create unique index documents_client_sha_live_key on documents (client_id, sha256) where deleted_at is null;
