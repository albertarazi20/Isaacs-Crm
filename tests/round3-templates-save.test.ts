import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/auth/session";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Round 3, templates saved through saveTemplateAction:
 *   - an unknown merge token ({firstname}) is refused at save time, naming the token, and nothing is stored;
 *   - a manager's save runs the claim checker: a failing template is stored UNapproved (the same as a rep's), and an
 *     approved template that is edited into a failing one loses its approval. Proved on the stored `approved` flag.
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
let boss: string;
let actions: typeof import("@/app/buckets-actions");

const as = async (id: string, email: string, role: "rep" | "manager") => {
  jar.token = await signSession({ userId: id, email, role, epoch: 0 }, SECRET);
};
const stored = async (id: string) =>
  (
    await t.pool.query<{ approved: boolean; approved_by: string | null; body: string }>(
      "select approved, approved_by, body from templates where id = $1",
      [id],
    )
  ).rows[0];
const count = async () =>
  Number((await t.pool.query<{ n: string }>("select count(*) as n from templates")).rows[0]!.n);

beforeAll(async () => {
  t = await createTestDb();
  const url = new URL(
    (t.pool as unknown as { options: { connectionString: string } }).options.connectionString,
  );
  process.env.DATABASE_URL = url.toString();
  process.env.SESSION_SECRET = SECRET;
  process.env.APP_URL = "https://crm.test";
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  boss = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [boss]);
  actions = await import("@/app/buckets-actions");
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

describe("unknown merge fields are refused when a template is saved", () => {
  it("a typo in the body is named and nothing is stored", async () => {
    await as(rep, "rep@x.com", "rep");
    const before = await count();
    const r = await actions.saveTemplateAction({
      name: "Typo",
      subject: "Hi",
      body: "Hello {firstname}, thanks",
    });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/\{firstname\}.*isn't a field I know/);
    expect(await count()).toBe(before);
  });

  it("a typo in the subject is caught too, and an update with a typo leaves the stored body alone", async () => {
    await as(boss, "boss@x.com", "manager");
    const ok = await actions.saveTemplateAction({
      name: "Good",
      subject: "Hi {first_name}",
      body: "Statements for {business}: {upload_link}",
    });
    expect(ok.ok).toBe(true);
    const id = ok.ok ? ok.data.id : "";
    const bad = await actions.saveTemplateAction({
      id,
      name: "Good",
      subject: "Re: {busines}",
      body: "changed {first_name}",
    });
    expect(!bad.ok && bad.error).toMatch(/\{busines\}/);
    expect((await stored(id))?.body).toBe("Statements for {business}: {upload_link}");
  });

  it("every real merge field still saves", async () => {
    await as(rep, "rep@x.com", "rep");
    const r = await actions.saveTemplateAction({
      name: "All fields",
      subject: "{business}",
      body: "{first_name} {sender} {application_link} {amount_wanted} {upload_link} {missing_docs}",
    });
    expect(r.ok).toBe(true);
  });
});

describe("a manager's template save runs the claim checker", () => {
  it("a clean template saved by a manager is approved; a failing one is stored unapproved", async () => {
    await as(boss, "boss@x.com", "manager");
    const clean = await actions.saveTemplateAction({
      name: "Clean",
      subject: "Statements",
      body: "Hi {first_name}, upload here: {upload_link}",
    });
    expect(clean.ok).toBe(true);
    expect(await stored(clean.ok ? clean.data.id : "")).toMatchObject({
      approved: true,
      approved_by: boss,
    });

    const bad = await actions.saveTemplateAction({
      name: "Claims",
      subject: "You are approved",
      body: "Guaranteed, no upfront fees on this loan",
    });
    expect(bad.ok).toBe(true);
    expect(bad.ok && bad.data.claimReasons?.length).toBeGreaterThan(0);
    expect(await stored(bad.ok ? bad.data.id : "")).toMatchObject({
      approved: false,
      approved_by: null,
    });
  });

  it("editing an approved template into a failing one revokes the approval; fixing it does not re-approve silently", async () => {
    await as(boss, "boss@x.com", "manager");
    const made = await actions.saveTemplateAction({
      name: "Edited",
      subject: "Statements",
      body: "Hi {first_name}, upload here: {upload_link}",
    });
    const id = made.ok ? made.data.id : "";
    expect((await stored(id))?.approved).toBe(true);

    const worse = await actions.saveTemplateAction({
      id,
      name: "Edited",
      subject: "Statements",
      body: "Hi {first_name}, this loan is guaranteed",
    });
    expect(worse.ok).toBe(true);
    expect(await stored(id)).toMatchObject({ approved: false, approved_by: null });

    const fixed = await actions.saveTemplateAction({
      id,
      name: "Edited",
      subject: "Statements",
      body: "Hi {first_name}, upload here: {upload_link}",
    });
    expect(fixed.ok).toBe(true);
    // saving does not approve an existing template: the manager approves it from the list, as before
    expect((await stored(id))?.approved).toBe(false);
  });

  it("a rep's templates stay unapproved", async () => {
    await as(rep, "rep@x.com", "rep");
    const r = await actions.saveTemplateAction({
      name: "Rep",
      subject: "",
      body: "Hi {first_name}",
    });
    expect((await stored(r.ok ? r.data.id : ""))?.approved).toBe(false);
  });
});
