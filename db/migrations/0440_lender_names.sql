-- One lender list for the whole shop (0300) means one "Pearl", not one per rep. The per-user name key becomes a
-- shop-wide one. Merge any duplicates first: the oldest row keeps its id, its submissions and offers follow.
do $$
declare dup record;
begin
  for dup in
    select lower(btrim(name)) as key, min(created_at) as first_at from funders group by 1 having count(*) > 1
  loop
    update submissions s set funder_id = k.id
      from (select id from funders where lower(btrim(name)) = dup.key order by created_at limit 1) k
     where s.funder_id in (select id from funders where lower(btrim(name)) = dup.key and id <> k.id);
    delete from funders where lower(btrim(name)) = dup.key
       and id <> (select id from funders where lower(btrim(name)) = dup.key order by created_at limit 1);
  end loop;
end $$;
drop index if exists funders_user_name_key;
create unique index funders_name_key on funders (lower(btrim(name)));
