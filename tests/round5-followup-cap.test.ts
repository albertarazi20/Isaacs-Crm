/**
 * Round 5, Follow Up: the page asks for the capped list and tells the search box whether it was cut, instead of the
 * box guessing from the length. Proved in the database (5001 merchants in follow-up) and on the rendered search box.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/components/app-context", () => ({ useApp: () => ({ today: "2026-11-18" }) }));

import { AllMembersSearch } from "@/components/followup/AllMembersSearch";
import { listAllMembersCapped, type BucketMember } from "@/lib/buckets/queries";
import { ALL_MEMBERS_MAX } from "@/lib/followup/limits";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

const member = (i: number) =>
  ({
    client_id: `c${i}`,
    business_name: `Shop ${i}`,
    contact_name: "Mike",
    phone: "3055550100",
    email: `m${i}@x.com`,
    state: "FL",
    bucket_id: "b1",
    bucket_name: "Interested",
    paused: false,
  }) as unknown as BucketMember;

const render = (members: BucketMember[], truncated: boolean) =>
  renderToStaticMarkup(createElement(AllMembersSearch, { members, truncated, canExport: false }));

describe("the find-anyone box says when the list was cut", () => {
  it("says 'the first N' when the page reports the list was truncated, even for a short list", () => {
    expect(render([member(1), member(2)], true)).toContain("Search the first 2 in follow-up");
  });

  it("says 'all N' when it was not, even when the list is exactly the cap", () => {
    const exactly = Array.from({ length: ALL_MEMBERS_MAX }, (_, i) => member(i));
    expect(render(exactly, false)).toContain(`Search all ${ALL_MEMBERS_MAX} in follow-up`);
    expect(render([member(1)], false)).toContain("Search all 1 in follow-up");
  });
});

describe("listAllMembersCapped against the database", () => {
  let t: TestDb;
  let rep: string;
  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "cap@x.com", "America/New_York");
  });
  afterAll(async () => {
    await t.drop();
  });

  it("is cut at the cap with truncated true, and not truncated at exactly the cap", async () => {
    const bucket = (
      await t.pool.query<{ id: string }>("select id from buckets where key = 'interested'")
    ).rows[0]!.id;
    await t.pool.query(
      `insert into clients (user_id, business_name, contact_name, phone, email, state)
       select $1, 'Cap Shop ' || g, 'Mike', '3055550100', 'cap' || g || '@x.com', 'FL'
         from generate_series(1, $2::int) g`,
      [rep, ALL_MEMBERS_MAX + 1],
    );
    await t.pool.query(
      `insert into enrollments (user_id, client_id, bucket_id)
       select user_id, id, $2 from clients where user_id = $1`,
      [rep, bucket],
    );
    const over = await t.db.withUser(rep, (q) => listAllMembersCapped(q));
    expect(over.members).toHaveLength(ALL_MEMBERS_MAX);
    expect(over.truncated).toBe(true);

    await t.pool.query(
      "update enrollments set stopped_at = now(), stop_reason = 'removed' where id = (select id from enrollments where user_id = $1 limit 1)",
      [rep],
    );
    const exact = await t.db.withUser(rep, (q) => listAllMembersCapped(q));
    expect(exact.members).toHaveLength(ALL_MEMBERS_MAX);
    expect(exact.truncated).toBe(false);
  }, 60_000);
});
