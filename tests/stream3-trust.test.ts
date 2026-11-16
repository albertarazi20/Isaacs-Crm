import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/auth/session";
import { backdoorScores, exposureReport, recordBackdoorReport } from "@/lib/trust/queries";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

// The export routes read the session cookie through next/headers; outside a Next request there is none, so the
// cookie jar is ours: whatever token the test sets is what the route sees.
const jar = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "isaac_session" && jar.token ? { value: jar.token } : undefined,
  }),
  headers: async () => new Headers(),
}));

let t: TestDb;
let rep: string;
let manager: string;
let pizza: string;
let pearl: string;
let alpha: string;

const SECRET = "s".repeat(40);

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query(
    "update app_users set role = 'manager', name = 'Boss', notify_email = 'alerts@x.com' where id = $1",
    [manager],
  );
  pizza = await insertClient(t.db, rep, "Pizza Palace");
  await t.pool.query("update clients set email = 'mike@pizza.com', state = 'NY' where id = $1", [
    pizza,
  ]);
  pearl = (
    await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name, submission_email) values ($1, 'Pearl', 'p@p.com') returning id",
      [manager],
    )
  ).rows[0]!.id;
  alpha = (
    await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name, submission_email) values ($1, 'Alpha', 'a@a.com') returning id",
      [manager],
    )
  ).rows[0]!.id;
  await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [pizza]));
  await t.db.withUser(manager, (q) =>
    q.query("select create_submissions($1, $2::uuid[])", [pizza, [pearl, alpha]]),
  );
  const taco = await insertClient(t.db, rep, "Taco Town");
  // its own phone: with the helper's one number, the double-submission guard (0512) would call Taco Town the same
  // owner as Pizza Palace and refuse its file to Pearl
  await t.pool.query("update clients set phone = '5559876543' where id = $1", [taco]);
  await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [taco]));
  await t.db.withUser(manager, (q) =>
    q.query("select create_submissions($1, $2::uuid[])", [taco, [pearl]]),
  );
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

describe("S2-12 backdoor reports and the per-lender score", () => {
  it("the report keeps the exposure snapshot and names every lender the file went to", async () => {
    await t.db.withUser(manager, async (q) => {
      const exposure = await exposureReport(q, pizza);
      await recordBackdoorReport(q, {
        clientId: pizza,
        reportedBy: manager,
        exposure,
        note: "merchant got a call from Rival Capital",
      });
      // the same day again is the same report, refreshed
      await recordBackdoorReport(q, {
        clientId: pizza,
        reportedBy: manager,
        exposure: await exposureReport(q, pizza),
      });
    });
    const rows = (
      await t.pool.query<{
        note: string;
        lender_ids: string[];
        exposure: { business_name: string; lenders: unknown[] };
      }>("select note, lender_ids, exposure from backdoor_reports where client_id = $1", [pizza])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.note).toBe("merchant got a call from Rival Capital");
    expect([...rows[0]!.lender_ids].sort()).toEqual([pearl, alpha].sort());
    expect(rows[0]?.exposure.business_name).toBe("Pizza Palace");
    expect(rows[0]?.exposure.lenders).toHaveLength(2);
  });
  it("score = reports per hundred files sent, worst lender first; a rep sees no reports at all", async () => {
    const scores = await t.db.withUser(manager, (q) => backdoorScores(q));
    expect(scores.map((s) => [s.name, s.files_sent, s.reports, s.score])).toEqual([
      ["Alpha", 1, 1, 100],
      ["Pearl", 2, 1, 50],
    ]);
    expect(
      (await t.db.withUser(
        rep,
        async (q) => (await q.query("select * from backdoor_reports")).rowCount,
      )) ?? 0,
    ).toBe(0);
    await expect(
      t.db.withUser(rep, (q) =>
        q.query("insert into backdoor_reports (client_id, reported_by) values ($1, $2)", [
          pizza,
          rep,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("S3-10 the export routes", () => {
  const AUTH_ENV = () => {
    const url = new URL(
      (t.pool as unknown as { options: { connectionString: string } }).options.connectionString,
    );
    process.env.DATABASE_URL = url.toString();
    process.env.SESSION_SECRET = SECRET;
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.RESEND_FROM = "Isaac <isaac@example.com>";
    process.env.APP_URL = "https://crm.test";
  };
  const asUser = async (userId: string, email: string, role: "rep" | "manager") => {
    jar.token = await signSession({ userId, email, role, epoch: 0 }, SECRET);
  };
  const logRows = async () =>
    (
      await t.pool.query<{ user_id: string; action: string; detail: string }>(
        "select user_id, action, detail from access_log where action in ('export', 'backup') order by at",
      )
    ).rows;

  it("a rep gets 403 and nothing is logged; a manager's export is logged and the managers are emailed", async () => {
    AUTH_ENV();
    const sent: { to: string[]; subject: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body) as { to: string[]; subject: string });
        return new Response(JSON.stringify({ id: "re_notify" }), { status: 200 });
      }),
    );
    try {
      const { GET } = await import("@/app/api/export/clients/route");
      await asUser(rep, "rep@x.com", "rep");
      const denied = await GET(new Request("http://localhost/api/export/clients"));
      expect(denied.status).toBe(403);
      expect(await logRows()).toEqual([]);
      expect(sent).toEqual([]);

      jar.token = "";
      expect((await GET(new Request("http://localhost/api/export/clients"))).status).toBe(401);

      await asUser(manager, "boss@x.com", "manager");
      const res = await GET(
        new Request("http://localhost/api/export/clients", {
          headers: { "x-forwarded-for": "203.0.113.9", "user-agent": "vitest" },
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/csv/);
      const csv = await res.text();
      expect(csv).toContain("Pizza Palace");
      expect(csv).toContain("Taco Town");
      const log = (
        await t.pool.query(
          "select user_id, action, detail, ip, user_agent from access_log where action = 'export'",
        )
      ).rows;
      expect(log).toEqual([
        {
          user_id: manager,
          action: "export",
          detail: "the merchant list (CSV)",
          ip: "203.0.113.9",
          user_agent: "vitest",
        },
      ]);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toEqual(["alerts@x.com"]);
      expect(sent[0]?.subject).toBe("Export downloaded: the merchant list (CSV)");

      const backup = await import("@/app/api/export/backup/route");
      const b = await backup.GET(new Request("http://localhost/api/export/backup"));
      expect(b.status).toBe(200);
      expect((await logRows()).map((r) => r.action)).toEqual(["export", "backup"]);
      expect(sent[1]?.subject).toBe("Backup downloaded: the full backup (JSON)");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
