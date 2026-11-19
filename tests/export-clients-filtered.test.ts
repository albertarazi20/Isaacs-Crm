import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/auth/session";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

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
let boss: string;
let pizza: string;
let tacos: string;
const SECRET = "s".repeat(40);

beforeAll(async () => {
  t = await createTestDb();
  const url = new URL(
    (t.pool as unknown as { options: { connectionString: string } }).options.connectionString,
  );
  process.env.DATABASE_URL = url.toString();
  process.env.SESSION_SECRET = SECRET;
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  boss = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [boss]);
  pizza = await insertClient(t.db, boss, "Pizza Palace");
  tacos = await insertClient(t.db, boss, "Taco Town");
  await insertClient(t.db, boss, "Noodle Nook");
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

const as = async (userId: string, email: string, role: "rep" | "manager") => {
  jar.token = await signSession({ userId, email, role, epoch: 0 }, SECRET);
};
const post = (ids: string) =>
  new Request("http://localhost/api/export/clients", {
    method: "POST",
    body: new URLSearchParams({ ids }),
  });

describe("the merchants list's 'Download these' goes through the server export", () => {
  it("a manager gets exactly the named merchants, and the download is audited with that row count", async () => {
    const { POST } = await import("@/app/api/export/clients/route");
    await as(boss, "boss@x.com", "manager");
    const res = await POST(post(`${pizza},${tacos}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("clients-filtered");
    const csv = await res.text();
    expect(csv).toContain("Pizza Palace");
    expect(csv).toContain("Taco Town");
    expect(csv).not.toContain("Noodle Nook");
    const logged = await t.pool.query(
      "select detail from audit_events where kind = 'export_download' order by at desc limit 1",
    );
    expect(logged.rows[0]?.detail).toEqual({ export: "clients", rows: 2 });
  });

  it("a rep is refused, a signed-out caller is turned away, and a bad body is a 400", async () => {
    const { POST } = await import("@/app/api/export/clients/route");
    await as(rep, "rep@x.com", "rep");
    expect((await POST(post(pizza))).status).toBe(403);
    jar.token = "";
    expect((await POST(post(pizza))).status).toBe(401);
    await as(boss, "boss@x.com", "manager");
    const bad = await POST(
      new Request("http://localhost/api/export/clients", { method: "POST", body: "{}" }),
    );
    expect(bad.status).toBe(400);
  });

  it("an id nobody owns adds no row, and it counts toward the 20-an-hour limit like any download", async () => {
    const { POST } = await import("@/app/api/export/clients/route");
    await as(boss, "boss@x.com", "manager");
    const csv = await (await POST(post(`${pizza},00000000-0000-0000-0000-000000000000`))).text();
    expect(csv.trim().split("\n")).toHaveLength(2); // header + Pizza Palace
    await t.pool.query("delete from audit_events");
    for (let i = 0; i < 20; i += 1) expect((await POST(post(pizza))).status).toBe(200);
    expect((await POST(post(pizza))).status).toBe(429);
  });
});
