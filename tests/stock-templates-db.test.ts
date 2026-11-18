import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expiryWords } from "@/lib/approvals/engine";
import { createApproval, editApproval } from "@/lib/approvals/mutations";
import { approvalSchema } from "@/lib/approvals/schemas";
import { STOCK_DESIGNS } from "@/lib/approvals/stock";
import { emailsStatus } from "@/lib/approvals/words";
import { signSession } from "@/lib/auth/session";
import { drainOutbox, type Deliverer } from "@/lib/send/worker";
import { advanceApprovalNow, runApprovalEmails } from "@/lib/system/approvals";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Loading the Selective Capital designs, through the real server action with a signed session, and every claim read
 * back from the database: the four slots, their subjects and waits, a second load changing nothing, a rep refused,
 * one failure undoing the whole load. Then the designs running the whole way: an approval marked, each follow-up
 * going its wait after the email before it was SENT, and a held email (no hold date, no rep phone).
 */

const jar = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "isaac_session" && jar.token ? { value: jar.token } : undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const SECRET = "s".repeat(40);
const APP = "https://crm.test";
const REP_EMAIL = "rep@shop.test";
const BOSS_EMAIL = "boss@shop.test";
const H = 3_600_000;
// Wednesday 18 Nov 2026, 2pm in Florida: inside the 9am to 6pm window
const NOW = new Date("2026-11-18T19:00:00Z");

let t: TestDb;
let boss: string;
let rep: string;
let actions: typeof import("@/app/approval-actions");

const as = async (id: string, email: string, role: "rep" | "manager") => {
  jar.token = await signSession({ userId: id, email, role, epoch: 0 }, SECRET);
};
interface Slot {
  step: number;
  subject: string;
  html: string;
  file_name: string;
  delay_hours: number;
  updated_by: string | null;
  updated_at: Date;
}
const slots = async () =>
  (
    await t.pool.query<Slot>(
      "select step, subject, html, file_name, delay_hours, updated_by, updated_at from approval_emails order by step",
    )
  ).rows;
const blank = async () => {
  await t.pool.query("delete from approval_emails where step > 4");
  await t.pool.query("update approval_emails set subject = '', html = '', file_name = ''");
  await t.pool.query(
    "update approval_emails set delay_hours = case step when 1 then 0 when 2 then 24 when 3 then 48 else 72 end",
  );
};
const audit = async () =>
  (
    await t.pool.query<{ kind: string; user_id: string; detail: { changed: string[] } }>(
      "select kind, user_id, detail from audit_events where kind = 'settings_approvals_saved' order by at",
    )
  ).rows;

beforeAll(async () => {
  t = await createTestDb();
  const url = new URL(
    (t.pool as unknown as { options: { connectionString: string } }).options.connectionString,
  );
  process.env.DATABASE_URL = url.toString();
  process.env.SESSION_SECRET = SECRET;
  process.env.APP_URL = APP;
  rep = await insertUser(t.pool, REP_EMAIL, "America/New_York");
  boss = await insertUser(t.pool, BOSS_EMAIL, "America/New_York");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [boss]);
  await t.pool.query("update app_users set name = 'josh miller' where id = $1", [rep]);
  await t.pool.query(
    "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status) values ($1, $2, 'enc', 'send', 'ok')",
    [rep, REP_EMAIL],
  );
  await t.pool.query(
    "update shop_settings set postal_address = '5301 N Federal Hwy, Boca Raton, FL 33487', approval_weekends = true",
  );
  actions = await import("@/app/approval-actions");
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});
beforeEach(async () => {
  await blank();
  await t.pool.query("delete from audit_events");
});

describe("loading the designs", () => {
  it("a rep cannot load them: refused, and not one slot changes", async () => {
    const before = await slots();
    expect(before.every((s) => s.html === "")).toBe(true);
    await as(rep, REP_EMAIL, "rep");
    await expect(actions.loadStockDesignsAction()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(await slots()).toEqual(before);
    expect(await audit()).toEqual([]);
  });

  it("writes the four slots in order with the right designs, subjects and waits", async () => {
    await as(boss, BOSS_EMAIL, "manager");
    const r = await actions.loadStockDesignsAction();
    expect(r).toEqual({ ok: true, data: { replaced: [1, 2, 3, 4], added: [], delays: [4] } });
    const rows = await slots();
    expect(rows.map((s) => s.step)).toEqual([1, 2, 3, 4]);
    expect(rows.map((s) => s.subject)).toEqual([
      "{{business_name}}: Approved for Funding",
      "Did you see your approval, {{first_name}}?",
      "Your offer is time-sensitive",
      "Should I keep your offer open, {{first_name}}?",
    ]);
    // the owner's design, byte for byte, as read back from the table
    for (const [i, s] of rows.entries())
      expect(Buffer.from(s.html, "utf8").equals(Buffer.from(STOCK_DESIGNS[i]!.html, "utf8"))).toBe(
        true,
      );
    expect(rows.map((s) => s.file_name)).toEqual([
      "initial.html",
      "follow-up-1.html",
      "follow-up-2.html",
      "follow-up-3.html",
    ]);
    // follow-up 1: 24 hours after the approval email, then 48 and 48 (about 1, 3 and 5 days)
    expect(rows.map((s) => s.delay_hours)).toEqual([0, 24, 48, 48]);
    expect(rows.every((s) => s.updated_by === boss)).toBe(true);
    // the manager's change is on the security log
    expect(await audit()).toMatchObject([
      { kind: "settings_approvals_saved", user_id: boss, detail: { changed: ["approval_emails"] } },
    ]);
  });

  it("loading twice changes nothing the second time (no write, no log line)", async () => {
    await as(boss, BOSS_EMAIL, "manager");
    await actions.loadStockDesignsAction();
    const once = await slots();
    const second = await actions.loadStockDesignsAction();
    expect(second).toEqual({ ok: true, data: { replaced: [], added: [], delays: [] } });
    expect(await slots()).toEqual(once);
    expect(await audit()).toHaveLength(1);
  });

  it("replaces what a manager put there, and puts the waits back", async () => {
    await as(boss, BOSS_EMAIL, "manager");
    await actions.loadStockDesignsAction();
    // slot 3 edited by hand, follow-up 1's wait changed to 36 hours
    const own = `<html><body><p>Hi {{first_name}}</p><a href="{{unsubscribe_link}}">Unsubscribe</a></body></html>`;
    expect(
      (
        await actions.saveApprovalDesignAction({
          step: 3,
          subject: "My own",
          html: own,
          fileName: "mine.html",
        })
      ).ok,
    ).toBe(true);
    expect((await actions.setApprovalDelayAction({ step: 2, hours: 36 })).ok).toBe(true);
    expect((await slots()).map((s) => [s.subject, s.delay_hours])).toEqual([
      ["{{business_name}}: Approved for Funding", 0],
      ["Did you see your approval, {{first_name}}?", 36],
      ["My own", 48],
      ["Should I keep your offer open, {{first_name}}?", 48],
    ]);
    const r = await actions.loadStockDesignsAction();
    expect(r).toEqual({ ok: true, data: { replaced: [3], added: [], delays: [2] } });
    const rows = await slots();
    expect(rows[2]).toMatchObject({
      subject: "Your offer is time-sensitive",
      file_name: "follow-up-2.html",
    });
    expect(rows[2]?.html).toBe(STOCK_DESIGNS[2]?.html);
    expect(rows.map((s) => s.delay_hours)).toEqual([0, 24, 48, 48]);
  });

  it("every wait is still the manager's to set, in hours or days, from an hour to 90 days", async () => {
    await as(boss, BOSS_EMAIL, "manager");
    await actions.loadStockDesignsAction();
    for (const hours of [1, 36, 72, 2160]) {
      expect((await actions.setApprovalDelayAction({ step: 3, hours })).ok).toBe(true);
      expect((await slots())[2]?.delay_hours).toBe(hours);
    }
    for (const hours of [0, 2161, 1.5])
      expect((await actions.setApprovalDelayAction({ step: 3, hours })).ok).toBe(false);
    expect((await slots())[2]?.delay_hours).toBe(2160);
    // the first email has no wait to set
    expect((await actions.setApprovalDelayAction({ step: 1, hours: 5 })).ok).toBe(false);
  });

  it("adds the slots a shorter sequence is missing, and leaves a fifth one alone", async () => {
    await as(boss, BOSS_EMAIL, "manager");
    await actions.removeApprovalStepAction();
    await actions.removeApprovalStepAction();
    expect((await slots()).map((s) => s.step)).toEqual([1, 2]);
    expect(await actions.loadStockDesignsAction()).toEqual({
      ok: true,
      data: { replaced: [1, 2, 3, 4], added: [3, 4], delays: [] },
    });
    expect((await slots()).map((s) => [s.step, s.subject !== "", s.delay_hours])).toEqual([
      [1, true, 0],
      [2, true, 24],
      [3, true, 48],
      [4, true, 48],
    ]);
    // a fifth email somebody added is not part of the designs: it stays, empty, with its own wait
    await actions.addApprovalStepAction();
    await actions.setApprovalDelayAction({ step: 5, hours: 96 });
    await actions.loadStockDesignsAction();
    const rows = await slots();
    expect(rows).toHaveLength(5);
    expect(rows[4]).toMatchObject({ step: 5, subject: "", html: "", delay_hours: 96 });
  });

  it("one refusal undoes the whole load: no slot is half-written", async () => {
    await as(boss, BOSS_EMAIL, "manager");
    // the third design cannot be stored: slots 1 and 2 were written first, and must not stay
    await t.pool.query(
      "alter table approval_emails add constraint refuse_third check (subject <> 'Your offer is time-sensitive')",
    );
    try {
      const r = await actions.loadStockDesignsAction();
      expect(r.ok).toBe(false);
    } finally {
      await t.pool.query("alter table approval_emails drop constraint refuse_third");
    }
    const rows = await slots();
    expect(rows.every((s) => s.html === "" && s.subject === "")).toBe(true);
    expect(rows.map((s) => s.delay_hours)).toEqual([0, 24, 48, 72]);
    expect(await audit()).toEqual([]);
  });

  it("recalls an email already queued from the old design, so the engine fills it from the new one", async () => {
    await as(boss, BOSS_EMAIL, "manager");
    await actions.loadStockDesignsAction();
    const { rows } = await t.pool.query<{ id: string }>(
      `insert into clients (user_id, business_name, contact_name, phone, email, state)
       values ($1, 'Queued Cafe', 'rosa diaz', '3055550201', 'rosa@queued.test', 'FL') returning id`,
      [rep],
    );
    await t.pool.query(
      `insert into outbox (user_id, client_id, lane, source, to_address, subject, text_body, html_body, not_before)
       values ($1, $2, 'approval', 'approval:00000000-0000-4000-8000-000000000001:step:3', 'rosa@queued.test', 's', 't', '<p>old</p>', now())`,
      [rep, rows[0]?.id],
    );
    const own = `<html><body><p>Hi</p><a href="{{unsubscribe_link}}">Unsubscribe</a></body></html>`;
    await actions.saveApprovalDesignAction({ step: 3, subject: "Mine", html: own, fileName: "m" });
    await actions.loadStockDesignsAction();
    const out = await t.pool.query<{ status: string; skip_reason: string | null }>(
      "select status, skip_reason from outbox where source like '%:step:3'",
    );
    expect(out.rows).toEqual([{ status: "cancelled", skip_reason: "design_changed" }]);
  });
});

describe("the designs, running the whole way", () => {
  const sent: { to: string; subject: string; text: string; html?: string }[] = [];
  const deliver: Deliverer = {
    gmail: async (_u, m) => (sent.push(m), `g_${sent.length}`),
    resend: async (m) => (sent.push(m), `r_${sent.length}`),
  };
  const drain = (now: Date) => drainOutbox({ db: t.db, deliver, now, appUrl: APP });
  const run = (now: Date) => runApprovalEmails({ db: t.db, appUrl: APP, now });
  const ctx = (now = NOW) => ({ userId: rep, now, appUrl: APP });
  let HOLD = "";
  let n = 0;

  async function merchant(business: string, contact = "mike harbor"): Promise<string> {
    n += 1;
    const { rows } = await t.pool.query<{ id: string }>(
      `insert into clients (user_id, business_name, contact_name, phone, email, state)
       values ($1, $2, $3, $4, $5, 'FL') returning id`,
      [
        rep,
        business,
        contact,
        `30555503${String(n).padStart(2, "0")}`,
        `owner${n}@harborpine.test`,
      ],
    );
    return rows[0]!.id;
  }
  async function approve(clientId: string, holdUntil: string | null) {
    const { approvalId } = await t.db.withUser(rep, (q) =>
      createApproval(q, approvalSchema.parse({ clientId, amount: "85000", holdUntil }), ctx()),
    );
    await advanceApprovalNow(t.db, approvalId, ctx());
    return approvalId;
  }
  const approvalRow = async (id: string) =>
    (
      await t.pool.query<{ emails: string; emails_note: string; next_step: number | null }>(
        "select emails, emails_note, next_step from approvals where id = $1",
        [id],
      )
    ).rows[0]!;
  const outbox = async (clientId: string) =>
    (
      await t.pool.query<{
        source: string;
        status: string;
        subject: string;
        sent_at: Date | null;
        html_body: string;
        text_body: string;
      }>(
        "select source, status, subject, sent_at, html_body, text_body from outbox where client_id = $1 and lane = 'approval' order by source",
        [clientId],
      )
    ).rows;

  beforeAll(async () => {
    HOLD = (await t.pool.query<{ d: string }>("select (current_date + 60)::text as d")).rows[0]!.d;
  });
  beforeEach(async () => {
    sent.length = 0;
    await t.pool.query("update app_users set phone = '(561) 915-1002' where id = $1", [rep]);
    await as(boss, BOSS_EMAIL, "manager");
    await actions.loadStockDesignsAction();
  });

  it("sends all four, each its wait after the one before was SENT, filled in and escaped, with a text part", async () => {
    const m = await merchant("Harbor & Pine O'Neil's Cafe");
    const id = await approve(m, HOLD);
    // step 1, sent ten minutes after it was queued
    let at = new Date(NOW.getTime() + H / 6);
    await drain(at);
    const sentAt = [at];
    // 24, then 48, then 48 hours after the one before went out
    for (const wait of [24, 48, 48]) {
      // one minute early: nothing is queued yet
      await run(new Date(at.getTime() + wait * H - 60_000));
      expect((await outbox(m)).filter((r) => r.status === "queued")).toHaveLength(0);
      at = new Date(at.getTime() + wait * H);
      await run(at);
      await drain(at);
      sentAt.push(at);
    }
    const rows = await outbox(m);
    expect(rows.map((r) => [r.source, r.status])).toEqual(
      [1, 2, 3, 4].map((s) => [`approval:${id}:step:${s}`, "sent"]),
    );
    expect(rows.map((r) => r.sent_at?.getTime())).toEqual(sentAt.map((d) => d.getTime()));
    expect(
      sentAt.map((d, i) => (i === 0 ? 0 : (d.getTime() - sentAt[i - 1]!.getTime()) / H)),
    ).toEqual([0, 24, 48, 48]);
    // 1, 3 and 5 days after the approval email
    expect(sentAt.map((d) => Math.round((d.getTime() - sentAt[0]!.getTime()) / H))).toEqual([
      0, 24, 72, 120,
    ]);
    // the next pass finds nothing left to send and closes the sequence
    await run(new Date(at.getTime() + H));
    expect((await approvalRow(id)).emails).toBe("finished");

    // what went out: subject plain, HTML escaped, a text part, the link, the rep
    expect(sent.map((s) => s.subject)).toEqual([
      "Harbor & Pine O'Neil's Cafe: Approved for Funding",
      "Did you see your approval, Mike?",
      "Your offer is time-sensitive",
      "Should I keep your offer open, Mike?",
    ]);
    const token = (
      await t.pool.query<{ unsubscribe_token: string }>(
        "select unsubscribe_token from clients where id = $1",
        [m],
      )
    ).rows[0]!.unsubscribe_token;
    for (const [i, s] of sent.entries()) {
      expect(s.to).toBe(`owner${n}@harborpine.test`);
      expect(s.html).toBeTruthy();
      expect(s.html).not.toContain("{{");
      expect(s.html).not.toContain("Harbor & Pine");
      expect(s.text).toContain("Mike");
      expect(s.text).not.toMatch(/\{\{|<|&amp;/);
      expect(s.html).toContain(`href="${APP}/u/${token}"`);
      expect(s.html).toContain('href="tel:+15619151002"');
      expect(s.html).toContain("Josh Miller");
      if (i !== 1) expect(s.html).toContain("Harbor &amp; Pine O&#39;Neil&#39;s Cafe");
    }
    // follow-up 3 quotes the funder's hold date
    expect(sent[3]?.html).toContain(expiryWords(HOLD));
    expect(sent[3]?.text).toContain(expiryWords(HOLD));
    // the stored copy agrees with what was delivered
    expect(rows[3]?.html_body).toBe(sent[3]?.html);
  });

  it("holds follow-up 3 (and says so) when the approval has no hold date, then sends it once a date is added", async () => {
    const m = await merchant("Harbor & Pine Cafe");
    const id = await approve(m, null);
    let at = NOW;
    await drain(at);
    for (const wait of [24, 48]) {
      at = new Date(at.getTime() + wait * H);
      await run(at);
      await drain(at);
    }
    expect((await outbox(m)).map((r) => [r.source.slice(-1), r.status])).toEqual([
      ["1", "sent"],
      ["2", "sent"],
      ["3", "sent"],
    ]);
    // the fourth is due 48 hours later: it does not go, and nothing with a literal field is sent
    at = new Date(at.getTime() + 48 * H);
    await run(at);
    await drain(at);
    expect((await outbox(m)).map((r) => r.source.slice(-1))).toEqual(["1", "2", "3"]);
    expect(sent).toHaveLength(3);
    const held = await approvalRow(id);
    expect(held).toMatchObject({
      emails: "running",
      emails_note: "missing:offer_expiry",
      next_step: 4,
    });
    // the card's words: which email, and the way to fix it
    const words = emailsStatus(
      {
        status: "open",
        emails: "running",
        halt: null,
        steps: [],
        needs_call: false,
        next_email_at: null,
        next_step: held.next_step,
        emails_note: held.emails_note,
      },
      () => "",
    );
    expect(words.detail).toBe("Follow-up 3 needs the hold date. Add it with Change.");
    // the rep adds the date (the card's Change): the email goes on the next pass
    await t.db.withUser(rep, (q) =>
      editApproval(
        q,
        { approvalId: id, amount: 8_500_000, holdUntil: HOLD, funder: "", note: "" },
        ctx(at),
      ),
    );
    await advanceApprovalNow(t.db, id, ctx(at));
    await drain(at);
    expect(sent).toHaveLength(4);
    expect(sent[3]?.subject).toBe("Should I keep your offer open, Mike?");
    expect(sent[3]?.html).toContain(expiryWords(HOLD));
    await run(new Date(at.getTime() + H));
    expect((await approvalRow(id)).emails).toBe("finished");
  });

  it("holds the first email while the rep has no phone number, then sends it", async () => {
    await t.pool.query("update app_users set phone = '' where id = $1", [rep]);
    const m = await merchant("Harbor & Pine Cafe");
    const id = await approve(m, HOLD);
    expect(await approvalRow(id)).toMatchObject({
      emails_note: "missing:rep_phone",
      next_step: 1,
    });
    expect(await outbox(m)).toEqual([]);
    await t.pool.query("update app_users set phone = '(561) 915-1002' where id = $1", [rep]);
    await run(NOW);
    await drain(NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.html).toContain('href="tel:+15619151002"');
    expect((await approvalRow(id)).emails_note).toBe("");
  });
});
