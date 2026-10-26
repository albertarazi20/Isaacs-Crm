-- Hosted Postgres (Supabase) turns row-level security ON for every table the moment it is created. `stages` is shared
-- reference data with no merchant or owner data in it, and the app role reads it both directly and inside invoker
-- functions (app.promote_to_offers_in asks which stage comes first). With RLS on and no policy the app role would
-- see an empty table: no error, the comparison turns NULL, and a deal would silently never move to "Offers in".
-- Make it explicit on every database: RLS on, and the app role may read every row. Nobody can change it.
alter table stages enable row level security;
create policy stages_read on stages for select to isaac_app using (true);
