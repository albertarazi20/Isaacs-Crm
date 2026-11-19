import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { advanceApproval } from "@/lib/approvals/engine";
import { checkDesign, fillApprovalEmail, telDigits } from "@/lib/approvals/html";
import {
  closeApproval,
  createApproval,
  editApproval,
  markPitched,
  reopenApproval,
  resumeApprovalEmails,
  saveApprovalDesign,
} from "@/lib/approvals/mutations";
import { approvalCadence, approvalStats } from "@/lib/approvals/queries";
import { approvalEditSchema, approvalSchema } from "@/lib/approvals/schemas";
import { canResume, offerMoney, setupNotices } from "@/lib/approvals/words";
import { advanceApprovalSafely } from "@/lib/system/approvals";
import type { DbAccess } from "@/lib/db";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The review findings of the Open approvals area. Pure rules first; every database claim is read back from the
 * database (approvals, outbox, activities), not from a return value.
 */

const wrap = (body: string, head = "") => `<!DOCTYPE html><html><head><title>t</title>${head}</head>
<body><p>${body}</p><p>5301 N Federal Hwy, Boca Raton</p><a href="{{unsubscribe_link}}">Unsubscribe</a></body></html>`;

describe("malformed merge fields (approvals-1)", () => {
  it.each([
    "{{first name}}",
    "{{first-name}}",
    "{{ rep.phone }}",
    "{{ offer_amount|upper }}",
    "{{<b>first_name</b>}}",
    "{{#if first_name}}",
    "{ {first_name}}",
  ])("refuses %s on save", (bad) => {
    const c = checkDesign(wrap(`Hi ${bad},`), "Hello");
    expect(c.errors.join(" ")).toMatch(/Not a field we can fill|Broken field/);
  });

  it("refuses a malformed field in the subject too", () => {
    const c = checkDesign(wrap("Hi {{first_name}}"), "Hi {{first name}}");
    expect(c.errors.join(" ")).toMatch(/Broken field/);
  });

  it("still accepts valid fields, spaced or upper-case, and braces in CSS", () => {
    const css = "<style>@media (max-width:600px){.a{color:red}}</style>";
    const c = checkDesign(wrap("Hi {{ First_Name }}, {{rep_phone}}", css), "Hi {{first_name}}");
    expect(c.errors).toEqual([]);
  });

  it("fill reports a malformed field instead of sending it as literal text", () => {
    const f = fillApprovalEmail(
      {
        subject: "Hi {{first name}}",
        html: "<p>{{first-name}} {{<b>first_name</b>}} {{first_name}}</p>",
      },
      { first_name: "Maria" },
    );
    expect(f.missing).toEqual([]);
    expect(f.unfilled.length).toBeGreaterThanOrEqual(2);
    expect(f.unfilled.join(" ")).toContain("{{first name}}");
  });

  it("a value that itself holds braces is not a broken field", () => {
    const f = fillApprovalEmail(
      { subject: "x", html: "<p>{{business_name}}</p>" },
      { business_name: "Acme {{Co}}" },
    );
    expect(f.unfilled).toEqual([]);
  });
});

describe("pure rules", () => {
  it("telDigits drops an extension (approvals-10)", () => {
    expect(telDigits("(561) 555-0142 x12")).toBe("+15615550142");
    expect(telDigits("561-555-0142 ext. 12")).toBe("+15615550142");
    expect(telDigits("561-555-0142 Ext 7")).toBe("+15615550142");
    expect(telDigits("(561) 555-0142")).toBe("+15615550142");
  });

  it("the hold date has to be a real date, and not in the past when created (approvals-9)", () => {
    const id = "6f1c2a9e-3b4d-4f5a-8c7d-0e1f2a3b4c5d";
    const parse = (holdUntil: string) =>
      approvalSchema.safeParse({ clientId: id, amount: "5000", holdUntil });
    expect(parse("2026-02-31").success).toBe(false);
    expect(parse("0000-01-01").success).toBe(false);
    expect(parse("2001-01-01").success).toBe(false);
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    expect(parse(future).success).toBe(true);
    const edit = (holdUntil: string) =>
      approvalEditSchema.safeParse({ approvalId: id, amount: "5000", holdUntil });
    expect(edit("2026-02-31").success).toBe(false);
    expect(edit(future).success).toBe(true);
  });

  it("the offer keeps its cents (approvals-6)", () => {
    expect(offerMoney(8_500_050)).toBe("$85,000.50");
    expect(offerMoney(9_999_999)).toBe("$99,999.99");
    expect(offerMoney(8_500_000)).toBe("$85,000");
  });

  it("an accepted offer cannot be resumed (approvals-7)", () => {
    const row = {
      status: "open",
      emails: "stopped",
      emails_note: "offer_accepted",
      halt: null,
    } as const;
    expect(canResume(row)).toBe(false);
    expect(canResume({ ...row, emails_note: "paused" })).toBe(true);
  });

  it("the warning box needs a reason (approvals-3)", () => {
    const base = {
      unready: 0,
      emailsOn: true,
      postalAddress: "5301 N Federal Hwy",
      myPhone: "",
      cadence: [{ step: 1, delay_hours: 0, ready: true, uses_phone: false }],
    };
    expect(setupNotices(base).any).toBe(false);
    expect(
      setupNotices({ ...base, cadence: [{ ...base.cadence[0]!, uses_phone: true }] }),
    ).toMatchObject({
      any: true,
      needsPhone: true,
    });
    expect(setupNotices({ ...base, emailsOn: false }).any).toBe(true);
    expect(setupNotices({ ...base, postalAddress: " " }).any).toBe(true);
    expect(setupNotices({ ...base, unready: 1 }).any).toBe(true);
  });

  it("an engine error after the commit is not reported as a failure (approvals-5)", async () => {
    const boom = {
      withSystem: async () => {
        throw new RangeError("Invalid time zone");
      },
    } as unknown as DbAccess;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await advanceApprovalSafely(boom, "a", { now: new Date(), appUrl: "https://x.test" });
    expect(r).toMatchObject({ kind: "waiting", note: "next_run" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("approvals against the database", () => {
  let t: TestDb;
  let rep: string;
  let boss: string;
  const APP = "https://crm.test";
  const NOW = new Date("2026-11-18T19:00:00Z");
  const ctx = (userId: string) => ({ userId, now: NOW, appUrl: APP });
  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await t.pool.query(sql, params)).rows[0] as T;
  let n = 0;
  const merchant = async (extra: { timezone?: string } = {}) => {
    n += 1;
    return (
      await one<{ id: string }>(
        `insert into clients (user_id, business_name, contact_name, phone, email, state, timezone)
         values ($1, $2, 'rosa diaz', $3, $4, 'FL', $5) returning id`,
        [
          rep,
          `Shop ${n}`,
          `30555503${String(n).padStart(2, "0")}`,
          `o${n}@shop${n}.com`,
          extra.timezone ?? null,
        ],
      )
    ).id;
  };
  /**
   * The rep sends the first email from their own mailbox and the system sends only follow-ups, so by default the rep
   * sent it a day before NOW: follow-up 1 (a 24 hour wait) is due now. `null`: not recorded yet, so the approval is held.
   */
  const approve = async (
    clientId: string,
    more: Record<string, unknown> = {},
    firstSentAt: Date | null = new Date(NOW.getTime() - 24 * 3_600_000),
  ) => {
    const { approvalId } = await t.db.withUser(rep, (q) =>
      createApproval(
        q,
        { ...approvalSchema.parse({ clientId, amount: "85000", ...more }), firstSentAt },
        ctx(rep),
      ),
    );
    return approvalId;
  };
  const advance = (id: string) =>
    t.db.withSystem((q) => advanceApproval(q, id, { now: NOW, appUrl: APP }));
  const design = (extra: string) =>
    `<html><head><title>x</title></head><body><p>Hi {{first_name}} ${extra}</p>
<p>5301 N Federal Hwy, Boca Raton, FL 33487 <a href="{{unsubscribe_link}}">Unsubscribe</a></p></body></html>`;
  const save = (step: number, subject: string, html: string) =>
    t.db.withUser(boss, (q) => saveApprovalDesign(q, { step, subject, html, fileName: "" }, boss));

  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "josh@selectivecap.com", "America/New_York");
    boss = await insertUser(t.pool, "boss@selectivecap.com");
    await t.pool.query("update app_users set role = 'manager' where id = $1", [boss]);
    await t.pool.query(
      "update app_users set name = 'josh miller', phone = '(561) 555-0142' where id = $1",
      [rep],
    );
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status) values ($1, 'josh@selectivecap.com', 'enc', 'send', 'ok')",
      [rep],
    );
    await t.pool.query(
      "update shop_settings set postal_address = '5301 N Federal Hwy, Boca Raton, FL 33487'",
    );
  });
  afterAll(async () => {
    await t.drop();
  });

  it("approvals-2: the phone and hold-date warnings see spaced and upper-case fields", async () => {
    await save(1, "Hello {{ Offer_Expiry }}", design("call {{ Rep_Phone }}"));
    const row = (await t.db.withUser(rep, (q) => approvalCadence(q))).find((s) => s.step === 1);
    expect(row).toMatchObject({ uses_phone: true, uses_expiry: true });
    await save(1, "Hello", design("plain"));
    const plain = (await t.db.withUser(rep, (q) => approvalCadence(q))).find((s) => s.step === 1);
    expect(plain).toMatchObject({ uses_phone: false, uses_expiry: false });
  });

  it("approvals-6: the email states the approved amount to the cent", async () => {
    await save(2, "Hello", design("for {{offer_amount}}"));
    const m = await merchant();
    const id = await approve(m, { amount: "85000.50" });
    const r = await advance(id);
    expect(r).toMatchObject({ kind: "queued", step: 2 });
    const out = await one<{ html_body: string; text_body: string; source: string }>(
      "select html_body, text_body, source from outbox where client_id = $1 and lane = 'approval'",
      [m],
    );
    expect(out.source).toBe(`approval:${id}:step:2`);
    expect(out.html_body).toContain("$85,000.50");
    expect(out.text_body).toContain("$85,000.50");
    const act = await one<{ body: string }>(
      "select body from activities where client_id = $1 and body like 'Approved:%'",
      [m],
    );
    expect(act.body).toContain("$85,000.50");
  });

  it("approvals-1: a design with a broken field holds the email at the engine", async () => {
    // saved before the rule existed, straight into the table (follow-up 1: the first email the system sends)
    await t.pool.query("update approval_emails set subject = 'Hello', html = $1 where step = 2", [
      design("Hi {{first name}}"),
    ]);
    const m = await merchant();
    const id = await approve(m);
    const r = await advance(id);
    expect(r).toMatchObject({ kind: "waiting" });
    expect(r.kind === "waiting" && r.note).toMatch(/^bad_field:/);
    const sent = await one<{ n: number }>(
      "select count(*)::int as n from outbox where client_id = $1 and lane = 'approval'",
      [m],
    );
    expect(sent.n).toBe(0);
    expect(
      await one("select emails, emails_note from approvals where id = $1", [id]),
    ).toMatchObject({ emails: "running", emails_note: expect.stringMatching(/^bad_field:/) });
    await save(2, "Hello", design("for {{offer_amount}}"));
  });

  it("approvals-4: Resume on emails that are already running keeps the reply on the stop check", async () => {
    const m = await merchant();
    const id = await approve(m);
    await t.pool.query(
      `insert into inbound_emails (mailbox_user_id, gmail_id, from_address, subject, received_at, client_id, kind)
       values ($1, 'g-res', 'owner@shop.com', 'Re', now(), $2, 'merchant')`,
      [rep, m],
    );
    await new Promise((r) => setTimeout(r, 30));
    const before = await one<{ since: Date }>(
      "select emails_since as since from approvals where id = $1",
      [id],
    );
    await t.db.withUser(rep, (q) => resumeApprovalEmails(q, id));
    const after = await one<{ since: Date; emails: string; halt: string | null }>(
      "select emails_since as since, emails, app.approval_halt(id) as halt from approvals where id = $1",
      [id],
    );
    expect(after.since.getTime()).toBe(before.since.getTime());
    expect(after.halt).toBe("replied");
  });

  it("approvals-8: an approval that is not open cannot be edited", async () => {
    const m = await merchant();
    const id = await approve(m, {}, null);
    await t.db.withUser(rep, (q) => markPitched(q, id, ctx(rep)));
    await expect(
      t.db.withUser(rep, (q) =>
        editApproval(q, approvalEditSchema.parse({ approvalId: id, amount: "1000" }), ctx(rep)),
      ),
    ).rejects.toThrow(/not open/);
    const row = await one<{ amount_cents: string }>(
      "select amount_cents from approvals where id = $1",
      [id],
    );
    expect(Number(row.amount_cents)).toBe(8_500_000);
    const logged = await one<{ n: number }>(
      "select count(*)::int as n from activities where client_id = $1 and body like 'Approval changed%'",
      [m],
    );
    expect(logged.n).toBe(0);
  });

  it("approvals-7: after the offer is accepted the emails stay stopped", async () => {
    const m = await merchant();
    const id = await approve(m, {}, null);
    await t.pool.query(
      `insert into merchant_offers (client_id, user_id, approval_id, funded_cents, factor_rate, frequency, payments,
                                    expires_at, status, accepted_at)
       values ($1, $2, $3, 5000000, 1.3, 'daily', 100, now() + interval '5 days', 'accepted', now())`,
      [m, rep, id],
    );
    // an Undo or a Resume brings the old running state back
    await t.pool.query("update approvals set emails = 'running', emails_note = '' where id = $1", [
      id,
    ]);
    const r = await advance(id);
    expect(r).toEqual({ kind: "stopped", note: "offer_accepted" });
    const row = await one<{ emails: string; emails_note: string }>(
      "select emails, emails_note from approvals where id = $1",
      [id],
    );
    expect(row).toMatchObject({ emails: "stopped", emails_note: "offer_accepted" });
    await expect(t.db.withUser(rep, (q) => resumeApprovalEmails(q, id))).rejects.toThrow(
      /accepted/,
    );
    const after = await one<{ emails: string }>("select emails from approvals where id = $1", [id]);
    expect(after.emails).toBe("stopped");
    // reopening after a close does not bring the emails back either
    await t.db.withUser(rep, (q) => closeApproval(q, id, "", ctx(rep)));
    await t.db.withUser(rep, (q) => reopenApproval(q, id, ctx(rep), true));
    await advance(id);
    const end = await one<{ emails: string }>("select emails from approvals where id = $1", [id]);
    expect(end.emails).not.toBe("running");
  });

  it("approvals-11: 'ending' counts a hold by the merchant's own date", async () => {
    await t.pool.query("delete from approvals");
    // UTC+14 and UTC-11: their local dates differ from the database's date for most of the day
    const far = await merchant({ timezone: "Pacific/Kiritimati" });
    const behind = await merchant({ timezone: "Pacific/Pago_Pago" });
    const today = (tz: string) =>
      one<{ d: string }>("select (now() at time zone $1)::date::text as d", [tz]);
    const kiri = (await today("Pacific/Kiritimati")).d;
    const pago = (await today("Pacific/Pago_Pago")).d;
    const farId = await approve(far, {}, null);
    const behindId = await approve(behind, {}, null);
    await t.pool.query("update approvals set hold_until = $2::date + 3 where id = $1", [
      farId,
      kiri,
    ]);
    await t.pool.query("update approvals set hold_until = $2::date + 4 where id = $1", [
      behindId,
      pago,
    ]);
    const stats = await t.db.withUser(rep, (q) => approvalStats(q));
    expect(stats.expiring).toBe(1);
  });
});
