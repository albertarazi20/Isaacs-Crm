import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handOff } from "@/lib/followup/handoff";
import { loadOverview, type Overview } from "@/lib/followup/overview";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The follow-up dashboard's loader (src/lib/followup/overview.ts) on a small seeded shop: two reps and a manager.
 * Rep A's book, this month: Reply (called, wrote back), Fresh (new, not called), Ready (file complete), Overdue,
 * Bounced, Upload (a merchant upload nobody opened), Done (replied, docs, handed off). Old Co is last month's, and
 * Trash Co is in the trash. Rep B has a new lead in Interested and a reply waiting.
 */

let t: TestDb;
let repA: string;
let repB: string;
let manager: string;
let month: string;
let phone = 3055550200;
const ids: Record<string, string> = {};
let mine: Overview;
let shop: Overview;

const merchant = async (userId: string, name: string) => {
  const id = await t.db.withUser(userId, async (q) => {
    phone += 1;
    const { rows } = await q.query<{ id: string }>(
      "select id from create_client($1::jsonb, $2::jsonb)",
      [
        JSON.stringify({
          business_name: name,
          contact_name: `${name} owner`,
          phone: String(phone),
          email: `owner${phone}@x.com`,
        }),
        JSON.stringify([{ kind: "follow_up", due_on: addDays(t.today, 1) }]),
      ],
    );
    return rows[0]!.id;
  });
  ids[name] = id;
  return id;
};
/** A call logged `minutes` after the lead landed (the rep's first touch). */
const called = (id: string, minutes: number) =>
  t.pool.query(
    `insert into activities (user_id, client_id, kind, body, occurred_at)
     select c.user_id, c.id, 'call', 'Spoke with the owner', c.created_at + make_interval(mins => $2)
       from clients c where c.id = $1`,
    [id, minutes],
  );
const replied = (id: string, subject: string) =>
  t.pool.query("select record_merchant_reply($1, $2, 'Here you go', 'owner@x.com')", [id, subject]);
const document = (id: string, source: "staff" | "upload_link", filename: string) =>
  t.pool.query(
    `insert into documents (user_id, client_id, kind, filename, content_type, size_bytes, sha256, storage_key, source)
     select c.user_id, c.id, 'other', $3, 'application/pdf', 10, repeat('a', 64), 'k/' || c.id || '/' || $3, $2
       from clients c where c.id = $1`,
    [id, source, filename],
  );
const enrol = (userId: string, id: string, key: string) =>
  t.db.withUser(userId, (q) =>
    q.query("select enroll_in_bucket($1, (select id from buckets where key = $2))", [id, key]),
  );

beforeAll(async () => {
  t = await createTestDb();
  month = t.today.slice(0, 7);
  repA = await insertUser(t.pool, "a@x.com");
  repB = await insertUser(t.pool, "b@x.com");
  manager = await insertUser(t.pool, "boss@x.com");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
    manager,
  ]);
  await t.pool.query("update app_users set name = 'Rep A' where id = $1", [repA]);
  await t.pool.query("update app_users set name = 'Rep B' where id = $1", [repB]);

  const reply = await merchant(repA, "Reply Co");
  await called(reply, 1);
  await replied(reply, "Re: documents");

  const fresh = await merchant(repA, "Fresh Co");
  await t.pool.query("update clients set looking_for = '$250k' where id = $1", [fresh]);

  const ready = await merchant(repA, "Ready Co");
  await called(ready, 3);
  await enrol(repA, ready, "ready_for_ops");
  await document(ready, "staff", "statement.pdf");
  await t.pool.query(
    `insert into activities (user_id, client_id, kind, body, occurred_at)
     select c.user_id, c.id, 'email', E'Your file is complete\\n\\nThanks for sending everything.', c.created_at + interval '4 minutes'
       from clients c where c.id = $1`,
    [ready],
  );

  const overdue = await merchant(repA, "Overdue Co");
  await called(overdue, 5);
  await t.pool.query(
    "update timers set due_on = $2::date - 3 where client_id = $1 and done_at is null",
    [overdue, t.today],
  );

  const bounced = await merchant(repA, "Bounced Co");
  await called(bounced, 6);
  await t.pool.query("update clients set email_bounced_at = now() where id = $1", [bounced]);

  const upload = await merchant(repA, "Upload Co");
  await called(upload, 7);
  await document(upload, "upload_link", "june-statement.pdf");

  const done = await merchant(repA, "Done Co");
  await called(done, 2);
  await enrol(repA, done, "interested");
  await replied(done, "Re: application");
  await t.pool.query(
    "update clients set reply_waiting_since = null, reply_waiting_subject = '' where id = $1",
    [done],
  );
  await document(done, "staff", "application.pdf");
  await t.pool.query(
    "insert into applications (client_id, user_id, fields, signer_name) values ($1, $2, '{}'::jsonb, 'Done Owner')",
    [done, repA],
  );
  await t.db.withUser(repA, (q) => handOff(q, done));

  // last month's: added, called and brought in before this month began
  const old = await merchant(repA, "Old Co");
  await t.pool.query(
    `update clients set created_at = date_trunc('month', now()) - interval '10 days',
                        brought_in_at = date_trunc('month', now()) - interval '9 days', brought_in_by = $2
      where id = $1`,
    [old, repA],
  );
  await called(old, 5);

  const trash = await merchant(repA, "Trash Co");
  await called(trash, 1);
  await t.db.withUser(repA, (q) => q.query("select trash_client($1)", [trash]));

  const otherReply = await merchant(repB, "Other Reply Co");
  await called(otherReply, 2);
  await replied(otherReply, "Re: quick question");
  const otherLead = await merchant(repB, "Other Lead Co");
  await enrol(repB, otherLead, "interested");

  mine = await t.db.withUser(repA, (q) =>
    loadOverview(q, { today: t.today, month, manager: false }),
  );
  shop = await t.db.withUser(manager, (q) =>
    loadOverview(q, { today: t.today, month, manager: true }),
  );
});
afterAll(async () => {
  await t.drop();
});

describe("loadOverview for a rep", () => {
  it("counts this month and last month from the rep's own merchants, never the trash", () => {
    expect(mine.kpis.thisMonth).toEqual({
      month,
      newLeads: 7,
      contacted: 6,
      replied: 2,
      docsIn: 3,
      broughtIn: 1,
    });
    expect(mine.kpis.lastMonth).toMatchObject({
      newLeads: 1,
      contacted: 1,
      replied: 0,
      docsIn: 0,
      broughtIn: 1,
    });
    expect(mine.kpis.lastMonth.month < month).toBe(true);
    expect(mine.kpis.overdue).toBe(1);
    expect(mine.kpis.replyWaiting).toBe(1);
    expect(mine.kpis.readyToHandOff).toBe(1);
    // first touches at 1, 2, 3, 5, 6 and 7 minutes
    expect(mine.kpis.speedToLeadMinutes).toBe(4);
  });

  it("the median days to bring a merchant in is computed from the database's own dates", async () => {
    const { rows } = await t.pool.query<{ days: number | null }>(
      `select round((percentile_cont(0.5) within group (
                order by greatest(0, extract(epoch from (brought_in_at - created_at)) / 86400)))::numeric, 1)::float as days
         from clients c where user_id = $1 and to_char(brought_in_at, 'YYYY-MM') = $2
          and not exists (select 1 from trashed_clients t where t.client_id = c.id)`,
      [repA, month],
    );
    expect(mine.kpis.daysToBringIn).toBe(rows[0]!.days);
    expect(mine.kpis.daysToBringIn).not.toBeNull();
  });

  it("the numbers are what the database holds", async () => {
    const { rows } = await t.pool.query<{ brought: number; overdue: number }>(
      `select (select count(*)::int from clients where user_id = $1 and brought_in_at is not null and to_char(brought_in_at, 'YYYY-MM') = $2) as brought,
              (select count(*)::int from timers where user_id = $1 and done_at is null and due_on < $3::date) as overdue`,
      [repA, month, t.today],
    );
    expect(rows[0]).toEqual({
      brought: mine.kpis.thisMonth.broughtIn,
      overdue: mine.kpis.overdue,
    });
  });

  it("the funnel follows this month's leads", () => {
    expect(mine.funnel).toEqual([
      { key: "leads", label: "Leads", count: 7 },
      { key: "contacted", label: "Contacted", count: 6 },
      { key: "replied", label: "Replied", count: 2 },
      { key: "docs_in", label: "Docs in", count: 3 },
      { key: "brought_in", label: "Brought in", count: 1 },
    ]);
  });

  it("the series is eight Mondays, oldest first, ending this week", () => {
    expect(mine.series).toHaveLength(8);
    const starts = mine.series.map((w) => w.weekStart);
    expect([...starts].sort()).toEqual(starts);
    for (const s of starts) expect(new Date(`${s}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(starts[7]! <= t.today && addDays(starts[7]!, 7) > t.today).toBe(true);
    expect(mine.series[7]).toMatchObject({ newLeads: 7, broughtIn: 1 });
    expect(mine.series.reduce((n, w) => n + w.newLeads, 0)).toBe(8);
    expect(mine.series.reduce((n, w) => n + w.broughtIn, 0)).toBe(2);
  });

  it("buckets list the system buckets in order with live members, without the handed-off merchant", () => {
    expect(mine.buckets.map((b) => b.key)).toEqual([
      "interested",
      "missing_app",
      "missing_statements",
      "missing_newest",
      "missing_id",
      "ready_for_ops",
      "cold",
    ]);
    const count = (key: string) => mine.buckets.find((b) => b.key === key)?.count;
    expect(mine.buckets.find((b) => b.key === "ready_for_ops")?.name).toBe("Ready to hand off");
    expect(count("ready_for_ops")).toBe(1);
    expect(count("interested")).toBe(0);
  });

  it("the queue ranks reply, new lead, ready, upload, bounce, overdue; one line per merchant", () => {
    expect(mine.queue.map((i) => [i.kind, i.businessName])).toEqual([
      ["reply", "Reply Co"],
      ["call_now", "Fresh Co"],
      ["ready", "Ready Co"],
      ["upload", "Upload Co"],
      ["bounced", "Bounced Co"],
      ["overdue", "Overdue Co"],
    ]);
    const by = (kind: string) => mine.queue.find((i) => i.kind === kind)!;
    expect(by("reply")).toMatchObject({
      clientId: ids["Reply Co"],
      contactName: "Reply Co owner",
      detail: "Re: documents",
      ownerName: null,
    });
    expect(by("call_now").detail).toBe("New lead · wants $250k");
    expect(by("upload").detail).toContain("june-statement.pdf");
    expect(by("overdue").detail).toMatch(/^Follow-up was due [A-Z][a-z]{2} \d{1,2}$/);
    expect(by("overdue").at.slice(0, 10)).toBe(addDays(t.today, -3));
    for (const i of mine.queue) expect(new Date(i.at).toISOString()).toBe(i.at);
  });

  it("the activity feed is the latest events on the rep's own merchants, newest first", () => {
    expect(mine.activity.length).toBeGreaterThan(0);
    expect(mine.activity.length).toBeLessThanOrEqual(14);
    const times = mine.activity.map((e) => e.at);
    expect([...times].sort().reverse()).toEqual(times);
    const kinds = new Set(mine.activity.map((e) => e.kind));
    for (const k of ["reply", "upload", "signed", "email_sent", "handed_off", "lead_added"])
      expect(kinds, k).toContain(k);
    expect(mine.activity.find((e) => e.kind === "email_sent")?.text).toBe(
      "Email sent: Your file is complete",
    );
    expect(mine.activity.find((e) => e.kind === "handed_off")).toMatchObject({
      clientId: ids["Done Co"],
      businessName: "Done Co",
      text: "Handed off — brought in",
    });
    const names = mine.activity.map((e) => e.businessName);
    expect(names.some((n) => n.startsWith("Other") || n === "Trash Co")).toBe(false);
  });

  it("has no per-rep table, and carries the email meters", () => {
    expect(mine.reps).toBeNull();
    expect(Array.isArray(mine.email)).toBe(true);
  });
});

describe("loadOverview for a manager", () => {
  it("counts everyone's merchants", () => {
    expect(shop.kpis.thisMonth).toMatchObject({
      newLeads: 9,
      contacted: 7,
      replied: 3,
      docsIn: 3,
      broughtIn: 1,
    });
    expect(shop.kpis.replyWaiting).toBe(2);
    expect(shop.kpis.speedToLeadMinutes).toBe(3);
    expect(shop.funnel.map((f) => f.count)).toEqual([9, 7, 3, 3, 1]);
    expect(shop.buckets.find((b) => b.key === "interested")?.count).toBe(1);
  });

  it("the queue covers both reps, newest reply first, and names the owner", () => {
    expect(shop.queue.map((i) => [i.kind, i.businessName, i.ownerName])).toEqual([
      ["reply", "Other Reply Co", "Rep B"],
      ["reply", "Reply Co", "Rep A"],
      ["call_now", "Other Lead Co", "Rep B"],
      ["call_now", "Fresh Co", "Rep A"],
      ["ready", "Ready Co", "Rep A"],
      ["upload", "Upload Co", "Rep A"],
      ["bounced", "Bounced Co", "Rep A"],
      ["overdue", "Overdue Co", "Rep A"],
    ]);
  });

  it("the per-rep table has one row per person for the month", () => {
    const row = (name: string) => shop.reps?.find((r) => r.name === name);
    expect(shop.reps?.map((r) => r.name).sort()).toEqual(["Boss", "Rep A", "Rep B"]);
    expect(row("Rep A")).toEqual({
      userId: repA,
      name: "Rep A",
      newLeads: 7,
      replied: 2,
      docsIn: 3,
      broughtIn: 1,
      overdue: 1,
      speedToLeadMinutes: 4,
    });
    expect(row("Rep B")).toEqual({
      userId: repB,
      name: "Rep B",
      newLeads: 2,
      replied: 1,
      docsIn: 0,
      broughtIn: 0,
      overdue: 0,
      speedToLeadMinutes: 2,
    });
    expect(row("Boss")).toMatchObject({ newLeads: 0, broughtIn: 0, speedToLeadMinutes: null });
  });

  it("a rep asking for the manager's table still only sees their own merchants in it", async () => {
    const o = await t.db.withUser(repB, (q) =>
      loadOverview(q, { today: t.today, month, manager: true }),
    );
    expect(o.kpis.thisMonth.newLeads).toBe(2);
    expect(o.reps?.reduce((n, r) => n + r.newLeads, 0)).toBe(2);
    expect(o.queue.map((i) => i.businessName).sort()).toEqual(["Other Lead Co", "Other Reply Co"]);
    expect(o.queue.every((i) => i.ownerName === null)).toBe(true);
  });
});
