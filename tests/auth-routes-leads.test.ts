import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateToken, hashToken } from "@/lib/leads/token";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

// The seen route asks who is signed in through next/headers; outside a Next request there is no cookie jar.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

// The routes read DATABASE_URL and the env once, so both are set before the first import of a route.
let t: TestDb;
let owner: string;
let teamRep: string;

beforeAll(async () => {
  t = await createTestDb();
  const url = (t.pool as unknown as { options: { connectionString: string } }).options
    .connectionString;
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = "s".repeat(40);
  process.env.APP_URL = "http://localhost:3000";
  // Only the owner is on the env list. Everyone else is an account added in Settings > Team.
  process.env.ALLOWED_EMAILS = "owner@x.com";
  delete process.env.RESEND_API_KEY;
  owner = await insertUser(t.pool, "owner@x.com");
  teamRep = await insertUser(t.pool, "newrep@team.com");
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

const makeToken = async (userId: string) => {
  const token = generateToken();
  await t.pool.query(
    "insert into lead_tokens (user_id, label, token_hash) values ($1, 'Website form', $2)",
    [userId, hashToken(token)],
  );
  return token;
};
const post = async (token: string, body: Record<string, unknown>) => {
  const { POST } = await import("@/app/api/leads/route");
  return POST(
    new Request("http://localhost:3000/api/leads", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
};
const clientsFor = async (userId: string, name: string) =>
  (
    await t.pool.query<{ user_id: string }>(
      "select user_id from clients where user_id = $1 and business_name = $2",
      [userId, name],
    )
  ).rows;

describe("POST /api/leads and the allowlist (accounts are the allowlist)", () => {
  it("a rep added in Team, who is not in ALLOWED_EMAILS, can post a lead: 201 and the merchant is theirs", async () => {
    const token = await makeToken(teamRep);
    const res = await post(token, { businessName: "Team Rep Tacos", phone: "3055550111" });
    expect(res.status).toBe(201);
    expect(await clientsFor(teamRep, "Team Rep Tacos")).toHaveLength(1);
  });

  it("an owner on the list still can", async () => {
    const token = await makeToken(owner);
    const res = await post(token, { businessName: "Owner Bagels", phone: "3055550112" });
    expect(res.status).toBe(201);
    expect(await clientsFor(owner, "Owner Bagels")).toHaveLength(1);
  });

  it("a disabled rep cannot: 401 and no merchant is saved", async () => {
    const token = await makeToken(teamRep);
    await t.pool.query("update app_users set active = false where id = $1", [teamRep]);
    const res = await post(token, { businessName: "Ghost Pizza", phone: "3055550113" });
    expect(res.status).toBe(401);
    expect(
      (await t.pool.query("select 1 from clients where business_name = 'Ghost Pizza'")).rowCount,
    ).toBe(0);
    // switching the account back on switches the token back on: the account is the switch
    await t.pool.query("update app_users set active = true where id = $1", [teamRep]);
    expect(
      (await post(token, { businessName: "Back Again Pizza", phone: "3055550114" })).status,
    ).toBe(201);
  });
});

describe("POST /api/seen with a malformed Origin", () => {
  const seen = async (
    headers: Record<string, string>,
    body: unknown = { kind: "apply", token: "nope" },
  ) => {
    const { POST } = await import("@/app/api/seen/route");
    return POST(
      new Request("http://localhost:3000/api/seen", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  };

  it("answers 403, not a crash, for Origin: null and for junk", async () => {
    expect((await seen({ origin: "null", host: "localhost:3000" })).status).toBe(403);
    expect((await seen({ origin: "not a url", host: "localhost:3000" })).status).toBe(403);
  });
  it("still 403 for another site and 204 for the same site or no Origin", async () => {
    expect((await seen({ origin: "https://evil.example", host: "localhost:3000" })).status).toBe(
      403,
    );
    expect((await seen({ origin: "http://localhost:3000", host: "localhost:3000" })).status).toBe(
      204,
    );
    expect((await seen({})).status).toBe(204);
  });
  it("a refused beacon records nothing", async () => {
    await seen({ origin: "null", host: "localhost:3000" });
    expect((await t.pool.query("select 1 from link_opens")).rowCount).toBe(0);
  });
});
