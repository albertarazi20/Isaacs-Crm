import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ALERT_KIND_LABELS, listAlerts, unreadAlertCount } from "@/lib/alerts/feed";
import { signSession } from "@/lib/auth/session";
import { SETTINGS_VIEWS } from "@/lib/nav";
import {
  AUDIT_KIND_LABELS,
  AUDIT_KINDS,
  AUDIT_PAGE_SIZE,
  browserOf,
  describeEvent,
  listAuditEvents,
  settingsChange,
} from "@/lib/settings/securityLog";
import { recordAudit } from "@/lib/system/audit";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

const jar = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "isaac_session" && jar.token ? { value: jar.token } : undefined,
  }),
  headers: async () => new Headers(),
}));

const SECRET = "s".repeat(40);
let t: TestDb;
let boss: string;
let rep: string;

beforeAll(async () => {
  t = await createTestDb();
  const url = (t.pool as unknown as { options: { connectionString: string } }).options
    .connectionString;
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = SECRET;
  process.env.APP_URL = "http://localhost:3000";
  boss = await insertUser(t.pool, "boss@x.com");
  rep = await insertUser(t.pool, "rep@x.com");
  await t.pool.query("update app_users set role = 'manager' where id = $1", [boss]);
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

describe("plain-English lines", () => {
  it("every kind has a label and a sentence with no holes in it", () => {
    for (const kind of AUDIT_KINDS) {
      expect(AUDIT_KIND_LABELS[kind], kind).toBeTruthy();
      const line = describeEvent({
        kind,
        email: "boss@x.com",
        detail: {
          target_email: "new@x.com",
          role: "rep",
          from: "rep",
          to: "manager",
          reason: "disabled",
          label: "Site",
          changed: ["daily_cap"],
          rows: 12,
          export: "clients",
          google_email: "g@x.com",
          method: "passcode",
        },
      });
      expect(line, kind).toMatch(/\.$/);
      expect(line, kind).not.toMatch(/undefined|null|\[object/);
    }
  });

  it("reads the way a manager would say it", () => {
    const d = (kind: string, detail: Record<string, unknown> = {}, email = "boss@x.com") =>
      describeEvent({ kind, email, detail });
    expect(d("signin_ok", { method: "google" })).toBe("boss@x.com signed in.");
    expect(d("signin_failed", { reason: "bad_passcode" }, "owner@x.com")).toBe(
      "A sign-in as owner@x.com failed: wrong passcode.",
    );
    expect(d("team_role_changed", { target_email: "a@x.com", from: "rep", to: "manager" })).toBe(
      "boss@x.com changed a@x.com from rep to manager.",
    );
    expect(d("export_download", { export: "clients", rows: 42 })).toBe(
      "boss@x.com downloaded the clients export: 42 rows.",
    );
    expect(d("settings_shop_saved", { changed: ["daily_cap", "send_on_weekends"] })).toBe(
      "boss@x.com changed daily send cap, weekend sending.",
    );
    expect(d("settings_approvals_saved", { changed: [] })).toBe(
      "boss@x.com saved the settings with no change.",
    );
    expect(d("lead_token_created", { label: "Site" })).toBe(
      'boss@x.com made a lead connection named "Site".',
    );
  });

  it("names the browser and the device in a few words", () => {
    expect(
      browserOf(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome on Mac");
    expect(
      browserOf(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iPhone");
    expect(browserOf("Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/121.0")).toBe(
      "Firefox on Windows",
    );
    expect(browserOf("")).toBe("an unknown browser");
  });

  it("a settings diff names changed keys, skips what the database derives, and shows numbers and switches only", () => {
    expect(
      settingsChange(
        {
          daily_cap: 1,
          shop_name: "A",
          dns_ok: true,
          updated_at: "x",
          playbook: "old",
          flag: false,
        },
        {
          daily_cap: 2,
          shop_name: "B",
          dns_ok: false,
          updated_at: "y",
          playbook: "new",
          flag: true,
        },
      ),
    ).toEqual({
      changed: ["daily_cap", "shop_name", "playbook", "flag"],
      values: { daily_cap: { from: 1, to: 2 }, flag: { from: false, to: true } },
    });
  });
});

describe("the settings navigation and the alert feed", () => {
  it("lists Security under Settings for managers only", () => {
    const item = SETTINGS_VIEWS.find((v) => v.href === "/settings/security");
    expect(item).toMatchObject({ label: "Security", manager: true });
  });

  it("the new alert kinds are labelled, shown to a manager, and link to the page", async () => {
    expect(ALERT_KIND_LABELS.security_new_device).toBeTruthy();
    expect(ALERT_KIND_LABELS.security_export).toBeTruthy();
    expect(ALERT_KIND_LABELS.security_failed_signins).toBeTruthy();
    await recordAudit(
      { kind: "signin_ok", userId: rep, email: "rep@x.com", ip: "1.1.1.1", userAgent: "a" },
      t.db,
    );
    await recordAudit(
      { kind: "signin_ok", userId: rep, email: "rep@x.com", ip: "2.2.2.2", userAgent: "b" },
      t.db,
    );
    const feed = await t.db.withUser(boss, (q) => listAlerts(q));
    expect(feed.find((a) => a.kind === "security_new_device")).toMatchObject({
      href: "/settings/security",
    });
    expect(await t.db.withUser(boss, (q) => unreadAlertCount(q))).toBeGreaterThan(0);
    expect((await t.db.withUser(rep, (q) => listAlerts(q))).map((a) => a.kind)).not.toContain(
      "security_new_device",
    );
  });
});

describe("Settings > Security", () => {
  const render = async (sp: Record<string, string> = {}) => {
    const { default: Page } = await import("@/app/(app)/settings/security/page");
    return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(sp) }));
  };
  const as = async (userId: string, email: string, role: "rep" | "manager") => {
    jar.token = await signSession({ userId, email, role, epoch: 0 }, SECRET);
  };

  it("a rep is sent away and a signed-out visitor to sign in", async () => {
    await as(rep, "rep@x.com", "rep");
    await expect(render()).rejects.toThrow(/NEXT_REDIRECT/);
    jar.token = "";
    await expect(render()).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it("a manager sees the lines in words, newest first, and can filter by kind and by person", async () => {
    await t.pool.query("delete from audit_events");
    await recordAudit(
      {
        kind: "signin_ok",
        userId: boss,
        email: "boss@x.com",
        ip: "9.9.9.9",
        userAgent: "Mozilla/5.0 (Windows) Firefox/121.0",
      },
      t.db,
    );
    await recordAudit(
      {
        kind: "signin_failed",
        email: "owner@x.com",
        ip: "8.8.8.8",
        detail: { reason: "bad_passcode" },
      },
      t.db,
    );
    await recordAudit(
      {
        kind: "export_download",
        userId: rep,
        email: "rep@x.com",
        detail: { export: "notes", rows: 7 },
      },
      t.db,
    );
    await as(boss, "boss@x.com", "manager");
    const all = await render();
    expect(all).toContain("boss@x.com signed in.");
    expect(all).toContain("A sign-in as owner@x.com failed: wrong passcode.");
    expect(all).toContain("rep@x.com downloaded the notes export: 7 rows.");
    expect(all).toContain("9.9.9.9 · Firefox on Windows");
    expect(all.indexOf("downloaded the notes")).toBeLessThan(all.indexOf("boss@x.com signed in."));

    const failed = await render({ kind: "signin_failed" });
    expect(failed).toContain("owner@x.com failed");
    expect(failed).not.toContain("downloaded the notes");
    const mine = await render({ user: rep });
    expect(mine).toContain("downloaded the notes");
    expect(mine).not.toContain("boss@x.com signed in.");
    expect(await render({ kind: "nonsense", user: "not-an-id" })).toContain(
      "boss@x.com signed in.",
    );
  });

  it("shows only the last 200 lines", async () => {
    await t.pool.query("delete from audit_events");
    await t.pool.query(
      `insert into audit_events (kind, email, at) select 'signout', 'n' || g || '@x.com', now() - make_interval(secs => g) from generate_series(1, 250) g`,
    );
    const rows = await t.db.withUser(boss, (q) => listAuditEvents(q));
    expect(rows).toHaveLength(AUDIT_PAGE_SIZE);
    expect(rows[0]?.email).toBe("n1@x.com");
    expect(rows.at(-1)?.email).toBe("n200@x.com");
  });
});
