import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/auth/session";
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

const SECRET = "s".repeat(40);

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query(
    "update app_users set role = 'manager', name = 'Boss', notify_email = 'alerts@x.com' where id = $1",
    [manager],
  );
  await insertClient(t.db, rep, "Pizza Palace");
  await insertClient(t.db, manager, "Taco Town");
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

describe("the export routes", () => {
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

  it("a rep is refused and a signed-out caller is turned away; a manager downloads, and nothing is logged or emailed", async () => {
    AUTH_ENV();
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: "re_notify" }), { status: 200 });
      }),
    );
    try {
      const { GET } = await import("@/app/api/export/clients/route");
      await asUser(rep, "rep@x.com", "rep");
      const denied = await GET(new Request("http://localhost/api/export/clients"));
      expect(denied.status).toBe(403);

      jar.token = "";
      expect((await GET(new Request("http://localhost/api/export/clients"))).status).toBe(401);

      await asUser(manager, "boss@x.com", "manager");
      const res = await GET(new Request("http://localhost/api/export/clients"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/csv/);
      const csv = await res.text();
      expect(csv).toContain("Pizza Palace");
      expect(csv).toContain("Taco Town");

      const backup = await import("@/app/api/export/backup/route");
      expect((await backup.GET(new Request("http://localhost/api/export/backup"))).status).toBe(
        200,
      );
      const activity = await import("@/app/api/export/activity/route");
      expect((await activity.GET(new Request("http://localhost/api/export/activity"))).status).toBe(
        200,
      );
      // no access log line and no e-mail about a download
      expect(
        (await t.pool.query("select 1 from access_log where action in ('export', 'backup')"))
          .rowCount,
      ).toBe(0);
      expect(sent).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
