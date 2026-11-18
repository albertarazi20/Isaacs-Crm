import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signOAuthState } from "@/lib/auth/google";
import { signSession } from "@/lib/auth/session";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

/**
 * Every place the audit log is written, driven the way the browser drives it (the real route or server action, a
 * signed session cookie, a request address and browser), then audit_events and user_alerts read back from the
 * database. Google's token exchange is the only thing faked.
 */

const jar = vi.hoisted(() => ({
  token: "",
  ip: "203.0.113.7",
  ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "isaac_session" && jar.token ? { value: jar.token } : undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers({ "x-nf-client-connection-ip": jar.ip, "user-agent": jar.ua }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const google = vi.hoisted(() => ({
  email: "rep@x.com",
  verified: true,
  scope: "openid email profile",
  fail: false,
}));
vi.mock("@/lib/auth/google", async (orig) => {
  const m = await orig<typeof import("@/lib/auth/google")>();
  return {
    ...m,
    exchangeCode: async () => {
      if (google.fail) throw new Error("token exchange failed");
      return { id_token: "t", refresh_token: "r-secret-token", scope: google.scope };
    },
    verifyIdToken: async () => ({
      email: google.email,
      emailVerified: google.verified,
      name: "Some One",
    }),
  };
});

const SECRET = "s".repeat(40);
const ORIGIN = "http://localhost:3000";
const PASSCODE = "correct horse battery staple";
let t: TestDb;
let boss: string;
let rep: string;
let owner: string;

const events = async (where = "true", params: unknown[] = []) =>
  (
    await t.pool.query<{
      kind: string;
      email: string;
      ip: string;
      user_agent: string;
      user_id: string | null;
      detail: Record<string, unknown>;
    }>(
      `select kind, email, ip, user_agent, user_id, detail from audit_events where ${where} order by at, id`,
      params,
    )
  ).rows;
const kinds = async () => (await events()).map((e) => e.kind);
const as = async (userId: string, email: string, role: "rep" | "manager") => {
  const epoch = (
    await t.pool.query<{ session_epoch: number }>(
      "select session_epoch from app_users where id = $1",
      [userId],
    )
  ).rows[0]?.session_epoch;
  jar.token = await signSession({ userId, email, role, epoch: epoch ?? 0 }, SECRET);
};
const alertsOf = async (kind: string) =>
  (await t.pool.query("select user_id, title, body from user_alerts where kind = $1", [kind])).rows;

beforeAll(async () => {
  t = await createTestDb();
  const url = (t.pool as unknown as { options: { connectionString: string } }).options
    .connectionString;
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = SECRET;
  process.env.APP_URL = ORIGIN;
  process.env.ALLOWED_EMAILS = "owner@x.com";
  process.env.ACCESS_PASSCODE = PASSCODE;
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.CRON_SECRET = "c".repeat(24);
  boss = await insertUser(t.pool, "boss@x.com");
  rep = await insertUser(t.pool, "rep@x.com");
  owner = await insertUser(t.pool, "owner@x.com");
  await t.pool.query("update app_users set role = 'manager' where id = any($1)", [[boss, owner]]);
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});
beforeEach(async () => {
  jar.token = "";
  jar.ip = "203.0.113.7";
  await t.pool.query("delete from audit_events");
  await t.pool.query("delete from user_alerts");
  await t.pool.query("delete from passcode_attempts");
});

describe("passcode sign-in", () => {
  const post = async (passcode: string, ip = jar.ip) => {
    const { POST } = await import("@/app/api/auth/passcode/route");
    const form = new FormData();
    form.set("passcode", passcode);
    return POST(
      new NextRequest(`${ORIGIN}/api/auth/passcode`, {
        method: "POST",
        headers: { origin: ORIGIN, "x-nf-client-connection-ip": ip, "user-agent": jar.ua },
        body: form,
      }),
    );
  };

  it("a right passcode writes a sign-in line with the person, address and browser", async () => {
    const res = await post(PASSCODE);
    expect(res.status).toBe(303);
    expect(res.cookies.get("isaac_session")?.value).toBeTruthy();
    expect(await events()).toEqual([
      {
        kind: "signin_ok",
        email: "owner@x.com",
        ip: "203.0.113.7",
        user_agent: jar.ua,
        user_id: owner,
        detail: { method: "passcode" },
      },
    ]);
  });

  it("a wrong passcode writes a failed line (never the passcode); the fifth also alerts the managers", async () => {
    for (let i = 0; i < 5; i += 1) await post(`wrong guess ${i}`);
    const lines = await events();
    expect(lines).toHaveLength(5);
    expect(lines.every((l) => l.kind === "signin_failed" && l.email === "owner@x.com")).toBe(true);
    expect(JSON.stringify(lines)).not.toContain("wrong guess");
    expect(lines[0]?.detail).toMatchObject({ method: "passcode", reason: "bad_passcode" });
    expect(lines[4]?.detail).toMatchObject({ locked: true });
    const alerts = await alertsOf("security_failed_signins");
    expect(alerts.map((a) => a.user_id).sort()).toEqual([boss, owner].sort());
  });

  it("an attempt refused while locked is not written down", async () => {
    for (let i = 0; i < 5; i += 1) await post(`wrong ${i}`);
    expect((await post(PASSCODE)).status).toBe(429);
    expect((await post("again")).status).toBe(429);
    expect(await events("kind = 'signin_failed'")).toHaveLength(5);
    expect(await events("kind = 'signin_ok'")).toHaveLength(0);
  });

  it("a failed audit insert never breaks sign-in", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await t.pool.query("alter table audit_events rename to audit_events_away");
    try {
      const ok = await post(PASSCODE);
      expect(ok.status).toBe(303);
      expect(ok.headers.get("location")).toBe(`${ORIGIN}/`);
      expect(ok.cookies.get("isaac_session")?.value).toBeTruthy();
      const bad = await post("nope");
      expect(bad.status).toBe(303);
      expect(bad.headers.get("location")).toContain("error=bad_passcode");
    } finally {
      await t.pool.query("alter table audit_events_away rename to audit_events");
    }
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.map((c) => c.join(" ")).join("\n")).not.toContain(PASSCODE);
    spy.mockRestore();
    expect(await events()).toHaveLength(0);
  });
});

describe("Google callback", () => {
  const callback = async (
    purpose: "login" | "gmail",
    { state = "st", cookieState = "st", ip = jar.ip, error = "" } = {},
  ) => {
    const { GET } = await import("@/app/api/auth/callback/route");
    const qs = error ? `error=${error}` : `code=c&state=${state}`;
    return GET(
      new NextRequest(`${ORIGIN}/api/auth/callback?${qs}`, {
        headers: {
          cookie: `isaac_oauth=${signOAuthState({ state: cookieState, purpose }, SECRET)}`,
          "x-nf-client-connection-ip": ip,
          "user-agent": jar.ua,
        },
      }),
    );
  };

  it("a sign-in writes the line; a first sign-in from a second device alerts the managers", async () => {
    google.email = "rep@x.com";
    expect((await callback("login")).headers.get("location")).toBe(`${ORIGIN}/`);
    expect(await events()).toEqual([
      {
        kind: "signin_ok",
        email: "rep@x.com",
        ip: "203.0.113.7",
        user_agent: jar.ua,
        user_id: rep,
        detail: { method: "google" },
      },
    ]);
    expect(await alertsOf("security_new_device")).toEqual([]);
    await callback("login", { ip: "198.51.100.9" });
    const alerts = await alertsOf("security_new_device");
    expect(alerts.map((a) => a.user_id).sort()).toEqual([boss, owner].sort());
    expect(alerts[0]?.body).toContain("198.51.100.9");
  });

  it("an address with no account, a bad state and a Google error are failed lines", async () => {
    google.email = "stranger@x.com";
    const refused = await callback("login");
    expect(refused.headers.get("location")).toContain("error=not_allowed");
    await callback("login", { cookieState: "other" });
    await callback("login", { error: "access_denied" });
    const lines = await events("kind = 'signin_failed'");
    expect(lines.map((l) => [l.email, l.detail.reason])).toEqual([
      ["stranger@x.com", "not_allowed"],
      ["", "bad_state"],
      ["", "access_denied"],
    ]);
    expect(lines.every((l) => l.ip === "203.0.113.7" && l.user_id === null)).toBe(true);
    expect(await events("kind = 'signin_ok'")).toHaveLength(0);
  });

  it("an unverified Google address and a failed token exchange are failed lines too", async () => {
    google.email = "rep@x.com";
    google.verified = false;
    await callback("login");
    google.verified = true;
    google.fail = true;
    await callback("login");
    google.fail = false;
    expect((await events("kind = 'signin_failed'")).map((l) => l.detail.reason)).toEqual([
      "not_allowed",
      "google_error",
    ]);
  });

  it("connecting Gmail is its own line, with the Google address and never the token", async () => {
    await as(rep, "rep@x.com", "rep");
    google.email = "rep@x.com";
    google.scope = "openid email https://www.googleapis.com/auth/gmail.send";
    const res = await callback("gmail");
    expect(res.headers.get("location")).toContain("gmail=connected");
    google.scope = "openid email profile";
    const lines = await events();
    expect(lines.map((l) => l.kind)).toEqual(["gmail_connected"]);
    expect(lines[0]).toMatchObject({ user_id: rep, email: "rep@x.com" });
    expect(JSON.stringify(lines)).not.toContain("r-secret-token");
    expect(
      (await t.pool.query("select 1 from gmail_connections where user_id = $1", [rep])).rowCount,
    ).toBe(1);
  });

  it("a failed Gmail connect round trip is not a failed sign-in", async () => {
    google.fail = true;
    await callback("gmail");
    google.fail = false;
    expect(await events()).toEqual([]);
  });

  it("a failed audit insert never breaks the Google sign-in", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    google.email = "rep@x.com";
    await t.pool.query("alter table audit_events rename to audit_events_away");
    try {
      const res = await callback("login");
      expect(res.headers.get("location")).toBe(`${ORIGIN}/`);
      expect(res.cookies.get("isaac_session")?.value).toBeTruthy();
    } finally {
      await t.pool.query("alter table audit_events_away rename to audit_events");
    }
    spy.mockRestore();
  });
});

describe("sign-out and Gmail disconnect (server actions)", () => {
  it("sign out and sign out everywhere each write a line; the epoch really moves for the second", async () => {
    const { logoutAction, logoutEverywhereAction } = await import("@/app/actions");
    await as(rep, "rep@x.com", "rep");
    await expect(logoutAction()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(await kinds()).toEqual(["signout"]);
    const before = (await t.pool.query("select session_epoch from app_users where id = $1", [rep]))
      .rows[0].session_epoch;
    await expect(logoutEverywhereAction()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(await kinds()).toEqual(["signout", "signout_everywhere"]);
    const after = (await t.pool.query("select session_epoch from app_users where id = $1", [rep]))
      .rows[0].session_epoch;
    expect(after).toBe(before + 1);
    expect((await events())[1]).toMatchObject({ user_id: rep, email: "rep@x.com", ip: jar.ip });
  });

  it("signing out with no session writes nothing", async () => {
    const { logoutAction } = await import("@/app/actions");
    await expect(logoutAction()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(await events()).toEqual([]);
  });

  it("disconnecting Gmail deletes the connection and writes the line", async () => {
    const { disconnectGmailAction } = await import("@/app/actions");
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope) values ($1, 'rep@x.com', 'enc', 's') on conflict do nothing",
      [rep],
    );
    await as(rep, "rep@x.com", "rep");
    expect((await disconnectGmailAction()).ok).toBe(true);
    expect(
      (await t.pool.query("select 1 from gmail_connections where user_id = $1", [rep])).rowCount,
    ).toBe(0);
    expect(await kinds()).toEqual(["gmail_disconnected"]);
  });
});

describe("the team", () => {
  it("add, role change, disable and enable each write their lines; disabling and a role change also end sessions", async () => {
    const { addTeamMemberAction, setTeamMemberAction } = await import("@/app/team-actions");
    await as(boss, "boss@x.com", "manager");
    const added = await addTeamMemberAction({
      email: "New.Person@x.com",
      name: "New",
      role: "rep",
    });
    expect(added.ok).toBe(true);
    const id = added.ok ? added.data.id : "";
    expect(await events()).toEqual([
      expect.objectContaining({
        kind: "team_added",
        email: "boss@x.com",
        user_id: boss,
        detail: { target_email: "new.person@x.com", role: "rep" },
      }),
    ]);

    await t.pool.query("delete from audit_events");
    expect((await setTeamMemberAction({ userId: id, role: "manager", active: true })).ok).toBe(
      true,
    );
    expect((await events()).map((e) => [e.kind, e.detail])).toEqual([
      ["team_role_changed", { target_email: "new.person@x.com", from: "rep", to: "manager" }],
      ["session_killed", { target_email: "new.person@x.com", reason: "role_changed" }],
    ]);

    await t.pool.query("delete from audit_events");
    expect((await setTeamMemberAction({ userId: id, role: "manager", active: false })).ok).toBe(
      true,
    );
    expect((await events()).map((e) => [e.kind, e.detail])).toEqual([
      ["team_disabled", { target_email: "new.person@x.com" }],
      ["session_killed", { target_email: "new.person@x.com", reason: "disabled" }],
    ]);
    expect(
      (await t.pool.query("select active from app_users where id = $1", [id])).rows[0].active,
    ).toBe(false);

    await t.pool.query("delete from audit_events");
    await setTeamMemberAction({ userId: id, role: "manager", active: true });
    expect(await kinds()).toEqual(["team_enabled"]);

    // a save that changes nothing, and one the database refuses, write nothing
    await t.pool.query("delete from audit_events");
    await setTeamMemberAction({ userId: id, role: "manager", active: true });
    expect((await setTeamMemberAction({ userId: boss, role: "rep", active: true })).ok).toBe(false);
    expect(await events()).toEqual([]);
  });

  it("a rep cannot make a team change, and nothing is written", async () => {
    const { addTeamMemberAction } = await import("@/app/team-actions");
    await as(rep, "rep@x.com", "rep");
    await expect(addTeamMemberAction({ email: "x@x.com", name: "X", role: "rep" })).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(await events()).toEqual([]);
  });
});

describe("lead tokens", () => {
  it("minting and turning off each write a line, with the label and never the token", async () => {
    const { createLeadTokenAction, revokeLeadTokenAction } = await import("@/app/lead-actions");
    await as(rep, "rep@x.com", "rep");
    const made = await createLeadTokenAction({ label: "Website form" });
    expect(made.ok).toBe(true);
    const token = made.ok ? made.data.token : "";
    expect(token.length).toBeGreaterThan(20);
    const lines = await events();
    expect(lines).toEqual([
      expect.objectContaining({
        kind: "lead_token_created",
        user_id: rep,
        detail: { label: "Website form" },
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain(token);
    const tokenId = (await t.pool.query("select id from lead_tokens where user_id = $1", [rep]))
      .rows[0].id as string;
    expect((await revokeLeadTokenAction({ id: tokenId })).ok).toBe(true);
    expect((await events()).map((e) => [e.kind, e.detail])).toEqual([
      ["lead_token_created", { label: "Website form" }],
      ["lead_token_revoked", { token_id: tokenId }],
    ]);
    expect(
      (await t.pool.query("select revoked_at from lead_tokens where id = $1", [tokenId])).rows[0]
        .revoked_at,
    ).not.toBeNull();
    // turning off a connection that is already off is refused and writes nothing more
    expect((await revokeLeadTokenAction({ id: tokenId })).ok).toBe(false);
    expect(await events()).toHaveLength(2);
  });
});

describe("settings saves", () => {
  const shop = {
    shopName: "Selective Capital",
    postalAddress: "123 Secret Street, Nowhere",
    dailyCap: 1500,
    amberAt: 1200,
    reservedForIntake: 150,
    sequencesEnabled: true,
    sendWindowStart: 9,
    sendWindowEnd: 11,
    sendOnWeekends: false,
    perMerchantDaily: 1,
    perMerchantWeekly: 3,
    automationFrom: "",
    automationReplyToRep: true,
  };

  it("the email settings line names the keys that changed, numbers and on/off only, never text", async () => {
    const { saveShopSettingsAction } = await import("@/app/settings-actions");
    await as(boss, "boss@x.com", "manager");
    expect((await saveShopSettingsAction({ ...shop })).ok).toBe(true);
    // a first save over the defaults: only the address differs
    expect((await events())[0]).toMatchObject({
      kind: "settings_shop_saved",
      user_id: boss,
      detail: { changed: ["postal_address"], values: {} },
    });
    await t.pool.query("delete from audit_events");
    expect(
      (await saveShopSettingsAction({ ...shop, dailyCap: 1800, sendOnWeekends: true })).ok,
    ).toBe(true);
    const line = (await events())[0];
    expect(line?.detail).toEqual({
      changed: ["daily_cap", "send_on_weekends"],
      values: { daily_cap: { from: 1500, to: 1800 }, send_on_weekends: { from: false, to: true } },
    });
    expect(JSON.stringify(await events())).not.toContain("Secret Street");
    expect((await t.pool.query("select daily_cap from shop_settings")).rows[0].daily_cap).toBe(
      1800,
    );
  });

  it("a rejected save writes nothing; the AI save has its own kind and never carries the house rules", async () => {
    const { saveShopSettingsAction, saveAiSettingsAction } = await import("@/app/settings-actions");
    await as(boss, "boss@x.com", "manager");
    expect((await saveShopSettingsAction({ ...shop, dailyCap: 5 })).ok).toBe(false);
    expect(await events()).toEqual([]);
    expect(
      (
        await saveAiSettingsAction({
          aiEnabled: true,
          aiModel: "claude-sonnet-5-5",
          aiDailyCapCents: 4321,
          brainOn: false,
          brainDailyPerRep: 5,
          playbook: "Never mention the secret rate card",
        })
      ).ok,
    ).toBe(true);
    const line = (await events())[0];
    expect(line?.kind).toBe("settings_ai_saved");
    expect(line?.detail.changed).toContain("playbook");
    expect(line?.detail.changed).toContain("ai_daily_cap_cents");
    expect(JSON.stringify(line)).not.toContain("secret rate card");
  });

  it("the approval settings save writes its own line", async () => {
    const { setApprovalSettingsAction } = await import("@/app/approval-actions");
    await as(boss, "boss@x.com", "manager");
    expect(
      (await setApprovalSettingsAction({ on: true, windowStart: 8, windowEnd: 17, weekends: true }))
        .ok,
    ).toBe(true);
    const line = (await events())[0];
    expect(line).toMatchObject({ kind: "settings_approvals_saved", user_id: boss });
    expect(line?.detail.changed).toEqual(
      expect.arrayContaining(["approval_window_start", "approval_window_end", "approval_weekends"]),
    );
    expect(line?.detail.values).toMatchObject({ approval_window_end: { from: 18, to: 17 } });
    expect(
      (await t.pool.query("select approval_window_end from shop_settings")).rows[0]
        .approval_window_end,
    ).toBe(17);
  });
});

describe("exports", () => {
  it("a manager's download writes who, what and how many rows; a rep is refused and nothing is written", async () => {
    const { GET } = await import("@/app/api/export/clients/route");
    await as(rep, "rep@x.com", "rep");
    expect((await GET()).status).toBe(403);
    jar.token = "";
    expect((await GET()).status).toBe(401);
    expect(await events()).toEqual([]);

    await as(boss, "boss@x.com", "manager");
    expect((await GET()).status).toBe(200);
    const activity = await import("@/app/api/export/activity/route");
    expect((await activity.GET()).status).toBe(200);
    const followup = await import("@/app/api/export/followup/route");
    const res = await followup.GET(
      new Request(`${ORIGIN}/api/export/followup?bucket=all`, {
        headers: { "x-nf-client-connection-ip": jar.ip, "user-agent": jar.ua },
      }),
    );
    expect(res.status).toBe(200);
    expect(
      (await events()).map((e) => [
        e.kind,
        e.email,
        e.user_id,
        e.ip,
        e.detail.export,
        e.detail.rows,
      ]),
    ).toEqual([
      ["export_download", "boss@x.com", boss, "203.0.113.7", "clients", expect.any(Number)],
      ["export_download", "boss@x.com", boss, "203.0.113.7", "notes", expect.any(Number)],
      ["export_download", "boss@x.com", boss, "203.0.113.7", "follow-up (all buckets)", 0],
    ]);
  });

  it("the row count is the real one", async () => {
    const { GET } = await import("@/app/api/export/clients/route");
    for (const name of ["Biz One", "Biz Two", "Biz Three"]) await insertClient(t.db, rep, name);
    await t.pool.query("delete from audit_events");
    await as(boss, "boss@x.com", "manager");
    const csv = await (await GET()).text();
    const lines = csv.trim().split("\n");
    expect(lines.length - 1).toBeGreaterThanOrEqual(3);
    expect((await events("kind = 'export_download'"))[0]?.detail).toEqual({
      export: "clients",
      rows: lines.length - 1,
    });
  });

  it("the 21st export in an hour is a 429 with a plain message, no file, and one refusal line", async () => {
    const { GET } = await import("@/app/api/export/clients/route");
    await as(boss, "boss@x.com", "manager");
    for (let i = 0; i < 20; i += 1) expect((await GET()).status).toBe(200);
    const refused = await GET();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("content-type")).not.toMatch(/csv/);
    expect(refused.headers.get("content-disposition")).toBeNull();
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.text()).toMatch(/20 exports in the last hour/);
    expect((await GET()).status).toBe(429);
    expect(await events("kind = 'export_download'")).toHaveLength(20);
    expect(await events("kind = 'export_blocked'")).toHaveLength(1);
    // the limit is per person: another manager is not held up by it
    await as(owner, "owner@x.com", "manager");
    expect((await GET()).status).toBe(200);
    // and the same person is refused on the other export routes too
    await as(boss, "boss@x.com", "manager");
    const activity = await import("@/app/api/export/activity/route");
    expect((await activity.GET()).status).toBe(429);
    const followup = await import("@/app/api/export/followup/route");
    expect((await followup.GET(new Request(`${ORIGIN}/api/export/followup`))).status).toBe(429);
    // an hour later the person can export again
    await t.pool.query(
      "update audit_events set at = now() - interval '61 minutes' where user_id = $1",
      [boss],
    );
    expect((await GET()).status).toBe(200);
  });
});

describe("the hourly job sweeps old lines", () => {
  it("the nightly route deletes lines older than 180 days and keeps the rest", async () => {
    await t.pool.query(
      `insert into audit_events (kind, email, at) values
         ('signin_ok', 'old@x.com', now() - interval '200 days'),
         ('signin_ok', 'fresh@x.com', now() - interval '10 days')`,
    );
    const { GET } = await import("@/app/api/cron/nightly/route");
    const res = await GET(
      new Request(`${ORIGIN}/api/cron/nightly`, {
        headers: { authorization: `Bearer ${"c".repeat(24)}` },
      }),
    );
    expect(res.status).toBeLessThan(600);
    const body = (await res.json()) as { auditSwept: number | null };
    expect(body.auditSwept).toBe(1);
    expect((await events()).map((e) => e.email)).toEqual(["fresh@x.com"]);
  });
});
