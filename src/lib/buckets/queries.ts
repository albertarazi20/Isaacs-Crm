import type { Db } from "../db";

export interface BucketRow {
  id: string;
  key: string | null;
  name: string;
  owner_id: string | null;
  rule: string | null;
  sort: number;
  active: boolean;
  /** Live enrolments right now. */
  members: number;
  steps: number;
}

/** Shared buckets plus the caller's own, in the order the Follow Up page shows them. RLS hides other reps' buckets. */
export async function listBuckets(q: Db, includeInactive = false): Promise<BucketRow[]> {
  const { rows } = await q.query<BucketRow>(
    `select b.id, b.key, b.name, b.owner_id, b.rule, b.sort, b.active,
            (select count(*)::int from enrollments e where e.bucket_id = b.id and e.stopped_at is null) as members,
            (select count(*)::int from bucket_steps s where s.bucket_id = b.id) as steps
       from buckets b
      where (b.active or $1)
      order by b.sort, b.name`,
    [includeInactive],
  );
  return rows;
}
