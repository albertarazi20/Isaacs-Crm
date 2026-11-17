import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advanceApproval, expiryWords } from "@/lib/approvals/engine";
import { advanceApprovalNow, runApprovalEmails } from "@/lib/system/approvals";
import {
  checkDesign,
  fieldsIn,
  hasPostalAddress,
  withFooter,
  fillApprovalEmail,
  htmlToText,
  subjectFromHtml,
  telDigits,
} from "@/lib/approvals/html";
import {
  closeApproval,
  createApproval,
  editApproval,
  clearApprovalDesign,
  markPitched,
  pauseApprovalEmails,
  reopenApproval,
  resumeApprovalEmails,
  saveApprovalDesign,
  setApprovalDelay,
  setMyPhone,
} from "@/lib/approvals/mutations";
import { approvalSchema } from "@/lib/approvals/schemas";
import { approvalStats, listApprovals, openApprovalCount } from "@/lib/approvals/queries";
import { buildRawEmail } from "@/lib/email/raw";
import { drainOutbox, type Deliverer } from "@/lib/send/worker";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Open approvals (0553): a merchant with an offer gets the shop's HTML approval emails on their own — the first when
 * the approval is marked, each follow-up a set time after the one before it was SENT — until a reply, a pitch, a close,
 * a pause or the hold date stops them. Every claim is read back from the DATABASE (approvals, outbox, activities).
 */

const design = (title: string, extra = "") => `<!DOCTYPE html><html><head>
<title>${title}</title><style>.h1{font-size:40px}</style></head>
<body><div style="display:none;max-height:0;overflow:hidden;">Your offer is ready.&#8199;&#65279;&#847;</div>
<h1>Congrats, {{first_name}}.<br>You&rsquo;re approved.</h1>
<p>Underwriting signed off on {{business_name}} for {{offer_amount}}.</p>${extra}
<a href="tel:{{rep_phone}}">Call me now</a>
<p>{{rep_name}} &middot; <a href="tel:{{rep_phone}}">{{rep_phone}}</a> &middot; <a href="mailto:{{rep_email}}?subject=Call%20me">{{rep_email}}</a></p>
<a href="https://selectivecap.com">Selective Capital</a>
<p>5301 N Federal Hwy, Boca Raton, FL 33487 <a href="{{unsubscribe_link}}">Unsubscribe</a></p>
</body></html>`;

describe("approval designs (pure)", () => {
  it("reads the subject from <title> and lists the fields used", () => {
    const html = design("Congrats {{first_name}}, you&rsquo;re approved");
    expect(subjectFromHtml(html)).toBe("Congrats {{first_name}}, you’re approved");
    expect(fieldsIn(html).used).toEqual([
      "first_name",
      "business_name",
      "offer_amount",
      "rep_phone",
      "rep_name",
      "rep_email",
      "unsubscribe_link",
    ]);
  });

  it("refuses a design without an unsubscribe link, with an unknown field, or with a forbidden claim", () => {
    expect(checkDesign(design("Hi"), "Hi").errors).toEqual([]);
    expect(checkDesign("<p>Hi {{first_name}}</p>", "Hi").errors.join(" ")).toMatch(
      /unsubscribe_link/,
    );
    expect(checkDesign(design("x", "<p>{{firstname}}</p>"), "x").errors.join(" ")).toMatch(
      /\{\{firstname\}\}/,
    );
    expect(checkDesign(design("x", "<p>Funding is guaranteed.</p>"), "x").errors.join(" ")).toMatch(
      /guaranteed/,
    );
    expect(checkDesign(design("x", "<p>Your loan is ready.</p>"), "x").errors.join(" ")).toMatch(
      /loan/,
    );
    // "approved" is the point of these emails
    expect(checkDesign(design("You're approved"), "You're approved").errors).toEqual([]);
    expect(checkDesign(design("x"), "  ").errors.join(" ")).toMatch(/subject/);
  });

  it("wants the unsubscribe link where it can be clicked, and checks the inbox preview line too", () => {
    const hidden = design("x").replace(
      '<a href="{{unsubscribe_link}}">Unsubscribe</a>',
      "<!-- {{unsubscribe_link}} -->",
    );
    expect(checkDesign(hidden, "x").errors.join(" ")).toMatch(/unsubscribe_link/);
    const preheader = design("x").replace("Your offer is ready.", "Guaranteed funding, no fees.");
    expect(checkDesign(preheader, "x").errors.join(" ")).toMatch(/guaranteed/);
  });

  it("finds the shop's postal address loosely, and puts the footer inside <body>", () => {
    expect(
      hasPostalAddress(
        "Selective Capital, Inc. · 5301 N Federal Hwy, Boca Raton",
        "5301 N Federal Hwy, Boca Raton, FL 33487",
      ),
    ).toBe(true);
    expect(hasPostalAddress("Selective Capital", "5301 N Federal Hwy, Boca Raton")).toBe(false);
    expect(withFooter("<html><body><p>x</p></body></html>", "<p>F</p>")).toBe(
      "<html><body><p>x</p><p>F</p></body></html>",
    );
  });

  it("takes scripts out and warns past Gmail's clipping size", () => {
    const c = checkDesign(design("x", "<script>alert(1)</script>"), "x");
    expect(c.html).not.toMatch(/script>/);
    expect(c.warnings.join(" ")).toMatch(/Scripts/);
    const big = checkDesign(design("x", `<p>${"a".repeat(120_000)}</p>`), "x");
    expect(big.errors).toEqual([]);
    expect(big.warnings.join(" ")).toMatch(/100 KB/);
  });

  it("fills values escaped, a tel: link as digits, and never blanks a missing field", () => {
    const f = fillApprovalEmail(
      { subject: "Congrats {{first_name}}", html: design("x") },
      {
        first_name: "Rosa",
        business_name: "Tacos & <Co>",
        offer_amount: "$85,000",
        rep_name: "Josh Miller",
        rep_phone: "(561) 555-0142",
        rep_email: "josh@selectivecap.com",
        unsubscribe_link: "https://crm.test/u/tok",
      },
    );
    expect(f.missing).toEqual([]);
    expect(f.subject).toBe("Congrats Rosa");
    expect(f.html).toContain("Tacos &amp; &lt;Co&gt;");
    expect(f.html).toContain('href="tel:+15615550142"');
    expect(f.html).toContain("(561) 555-0142");
    expect(f.html).toContain('href="https://crm.test/u/tok"');
    const g = fillApprovalEmail({ subject: "Hi", html: design("x") }, { first_name: "Rosa" });
    expect(g.missing).toContain("rep_phone");
    expect(g.html).toContain("tel:{{rep_phone}}");
    expect(telDigits("561.555.0142")).toBe("+15615550142");
    expect(telDigits("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("turns a design into readable plain text without the preheader or styling", () => {
    const text = htmlToText(
      fillApprovalEmail(
        { subject: "x", html: design("Title words") },
        {
          first_name: "Rosa",
          business_name: "Tacos",
          offer_amount: "$85,000",
          rep_name: "Josh",
          rep_phone: "5615550142",
          rep_email: "j@x.com",
          unsubscribe_link: "https://crm.test/u/tok",
        },
      ).html,
    );
    expect(text).toMatch(/^Congrats, Rosa\.\nYou’re approved\./);
    expect(text).toContain("Underwriting signed off on Tacos for $85,000.");
    expect(text).toContain("Selective Capital (https://selectivecap.com)");
    expect(text).toContain("Unsubscribe (https://crm.test/u/tok)");
    expect(text).not.toMatch(/Your offer is ready|font-size|Title words|&middot;/);
  });

  it("sends a designed email as multipart/alternative with both parts", () => {
    const raw = Buffer.from(
      buildRawEmail({
        from: "rep@x.com",
        to: "m@shop.com",
        subject: "Approved",
        text: "Plain words",
        html: "<p>Designed</p>",
      }),
      "base64url",
    ).toString("utf8");
    const boundary = /boundary="([^"]+)"/.exec(raw)?.[1] ?? "";
    expect(raw).toContain("Content-Type: multipart/alternative");
    const parts = raw.split(`--${boundary}`);
    expect(parts).toHaveLength(4);
    const body = (p: string) => Buffer.from(p.split("\r\n\r\n")[1] ?? "", "base64").toString();
    expect(parts[1]).toContain("text/plain");
    expect(body(parts[1] ?? "")).toBe("Plain words");
    expect(parts[2]).toContain("text/html");
    expect(body(parts[2] ?? "")).toBe("<p>Designed</p>");
    // no html: plain text as before
    const plain = Buffer.from(
      buildRawEmail({ from: "a@x.com", to: "b@x.com", subject: "s", text: "t" }),
      "base64url",
    ).toString();
    expect(plain).toContain('Content-Type: text/plain; charset="UTF-8"');
  });

  it("reads the approval form: amounts as typed, a date or none", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(approvalSchema.parse({ clientId: id, amount: "85k" }).amount).toBe(8_500_000);
    expect(approvalSchema.parse({ clientId: id, amount: "$85,000" }).amount).toBe(8_500_000);
    expect(() => approvalSchema.parse({ clientId: id, amount: "0" })).toThrow(/approved amount/);
    expect(() =>
      approvalSchema.parse({ clientId: id, amount: "50k", holdUntil: "soon" }),
    ).toThrow();
  });
});

describe("the approval emails (database)", () => {
  let t: TestDb;
  let rep: string;
  let other: string;
  let boss: string;
  /** The funder's hold: two months from the database's today, so the tests do not expire with the calendar. */
  let HOLD = "";
  const APP = "https://crm.test";
  // Wednesday 18 Nov 2026, 2pm in Florida: inside the 9am-6pm window
  const NOW = new Date("2026-11-18T19:00:00Z");
  const H = 3_600_000;
  const at = (hours: number) => new Date(NOW.getTime() + hours * H);
  const sent: { to: string; subject: string; text: string; html?: string }[] = [];
  const deliver: Deliverer = {
    gmail: async (_u, m) => (sent.push(m), `g_${sent.length}`),
    resend: async (m) => (sent.push(m), `r_${sent.length}`),
  };
  const drain = (now: Date) => drainOutbox({ db: t.db, deliver, now, appUrl: APP });
  const ctx = (userId: string, now = NOW) => ({ userId, now, appUrl: APP });

  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await t.pool.query(sql, params)).rows[0] as T;
  let n = 0;
  async function merchant(owner = rep, extra: Record<string, string> = {}): Promise<string> {
    n += 1;
    return (
      await one<{ id: string }>(
        `insert into clients (user_id, business_name, contact_name, phone, email, state)
         values ($1, $2, $3, $4, $5, 'FL') returning id`,
        [
          owner,
          extra.business ?? `Shop ${n}`,
          extra.contact ?? "rosa diaz",
          `30555502${String(n).padStart(2, "0")}`,
          `owner${n}@shop${n}.com`,
        ],
      )
    ).id;
  }
  // the action's two steps: the approval under the person's row security, then the engine on the owner connection
  async function approve(
    clientId: string,
    userId = rep,
    more: Partial<Record<string, unknown>> = {},
  ) {
    const { approvalId, started } = await t.db.withUser(userId, (q) =>
      createApproval(
        q,
        approvalSchema.parse({ clientId, amount: "85000", holdUntil: HOLD, ...more }),
        ctx(userId),
      ),
    );
    const first = started ? await advanceApprovalNow(t.db, approvalId, ctx(userId)) : null;
    return { approvalId, first };
  }
  async function resume(approvalId: string, userId: string, now: Date) {
    await t.db.withUser(userId, (q) => resumeApprovalEmails(q, approvalId));
    return advanceApprovalNow(t.db, approvalId, ctx(userId, now));
  }
  let replies = 0;
  /** A verified merchant reply, stamped with the database's own clock like the inbox sync does. */
  const reply = (clientId: string) =>
    t.pool.query(
      `insert into inbound_emails (mailbox_user_id, gmail_id, from_address, subject, received_at, client_id, kind)
       values ($1, $2, 'owner@shop.com', 'Re: approved', now(), $3, 'merchant')`,
      [rep, `g-${(replies += 1)}`, clientId],
    );
  const rows = async (clientId: string) =>
    (
      await t.pool.query<{
        source: string;
        status: string;
        skip_reason: string | null;
        subject: string;
        html_body: string;
        text_body: string;
        not_before: Date;
        sent_at: Date | null;
      }>(
        `select source, status, skip_reason, subject, html_body, text_body, not_before, sent_at
           from outbox where client_id = $1 and lane = 'approval' order by created_at`,
        [clientId],
      )
    ).rows;
  const approvalRow = (id: string) =>
    one<{
      status: string;
      emails: string;
      emails_note: string;
      next_step: number | null;
      next_email_at: Date | null;
    }>(
      "select status, emails, emails_note, next_step, next_email_at from approvals where id = $1",
      [id],
    );
  const run = (now: Date) => runApprovalEmails({ db: t.db, appUrl: APP, now });

  beforeAll(async () => {
    t = await createTestDb();
    HOLD = (await one<{ d: string }>("select (current_date + 60)::text as d")).d;
    rep = await insertUser(t.pool, "josh@selectivecap.com", "America/New_York");
    other = await insertUser(t.pool, "other@selectivecap.com");
    boss = await insertUser(t.pool, "boss@selectivecap.com");
    await t.pool.query("update app_users set role = 'manager' where id = $1", [boss]);
    await t.pool.query("update app_users set name = 'josh miller' where id = $1", [rep]);
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status) values ($1, 'josh@selectivecap.com', 'enc', 'send', 'ok')",
      [rep],
    );
    await t.pool.query(
      "update shop_settings set postal_address = '5301 N Federal Hwy, Boca Raton, FL 33487'",
    );
    // the four designs, saved through the manager's own path
    await t.db.withUser(boss, async (q) => {
      await saveApprovalDesign(
        q,
        {
          step: 1,
          subject: "",
          html: design("Congrats {{first_name}}, you're approved"),
          fileName: "1.html",
        },
        boss,
      );
      for (const step of [2, 3])
        await saveApprovalDesign(
          q,
          {
            step,
            subject: `Follow-up ${step - 1}, {{first_name}}`,
            html: design("x"),
            fileName: "",
          },
          boss,
        );
      await saveApprovalDesign(
        q,
        {
          step: 4,
          subject: "Last call",
          html: design("x", "<p>I can hold it until {{offer_expiry}}.</p>"),
          fileName: "",
        },
        boss,
      );
    });
  });
  afterAll(async () => {
    await t.drop();
  });

  it("a rep saves their own phone, and nobody else's", async () => {
    await t.db.withUser(other, (q) => setMyPhone(q, other, "(305) 555-0199"));
    expect(
      (await one<{ phone: string }>("select phone from app_users where id = $1", [other])).phone,
    ).toBe("(305) 555-0199");
    // row security: the same call aimed at another user changes nothing
    await t.db.withUser(other, (q) => setMyPhone(q, rep, "000"));
    expect(
      (await one<{ phone: string }>("select phone from app_users where id = $1", [rep])).phone,
    ).toBe("");
  });

  it("only a manager can change the designs", async () => {
    await expect(
      t.db.withUser(rep, (q) =>
        q.query("update approval_emails set subject = 'x' where step = 1").then((r) => r.rowCount),
      ),
    ).resolves.toBe(0);
    const s = await one<{ subject: string; file_name: string }>(
      "select subject, file_name from approval_emails where step = 1",
    );
    expect(s).toEqual({ subject: "Congrats {{first_name}}, you're approved", file_name: "1.html" });
  });

  it("holds the first email while the rep has no phone number, and says why", async () => {
    const m = await merchant();
    const { approvalId, first } = await approve(m);
    expect(first).toMatchObject({ kind: "waiting", note: "missing:rep_phone" });
    expect(await rows(m)).toHaveLength(0);
    expect(await approvalRow(approvalId)).toMatchObject({
      status: "open",
      emails: "running",
      emails_note: "missing:rep_phone",
      next_step: 1,
    });
    await t.pool.query("update app_users set phone = '(561) 555-0142' where id = $1", [rep]);
    await run(NOW);
    expect((await rows(m)).map((r) => r.source)).toEqual([`approval:${approvalId}:step:1`]);
    expect((await approvalRow(approvalId)).emails_note).toBe("");
  });

  it("queues the first email at once, filled in for the merchant, and logs the approval", async () => {
    const m = await merchant(rep, { business: "Tacos & Co", contact: "Mr. Luis Ortega" });
    const { approvalId } = await approve(m);
    const [r] = await rows(m);
    expect(r).toMatchObject({ status: "queued", subject: "Congrats Mr. Ortega, you're approved" });
    expect(r?.not_before.getTime()).toBe(NOW.getTime());
    const token = (
      await one<{ unsubscribe_token: string }>(
        "select unsubscribe_token from clients where id = $1",
        [m],
      )
    ).unsubscribe_token;
    expect(r?.html_body).toContain("Tacos &amp; Co for $85,000");
    expect(r?.html_body).toContain('href="tel:+15615550142"');
    expect(r?.html_body).toContain(`href="${APP}/u/${token}"`);
    expect(r?.html_body).toContain("Josh Miller");
    expect(r?.text_body).toContain("Congrats, Mr. Ortega.");
    const log = await one<{ body: string }>(
      "select body from activities where client_id = $1 and kind = 'system' order by created_at desc limit 1",
      [m],
    );
    expect(log.body).toBe(`Approved: $85,000, held until ${expiryWords(HOLD)}`);
    expect(await approvalRow(approvalId)).toMatchObject({ next_step: 1 });
  });

  it("sends the designed HTML with the plain-text footer, then times follow-up 1 from the moment it went", async () => {
    const m = await merchant();
    const { approvalId } = await approve(m);
    sent.length = 0;
    // the worker sends it ten minutes later
    const sentAt = at(1 / 6);
    await drain(sentAt);
    const mine = sent.filter((s) => s.to.startsWith(`owner${n}@`));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.html).toContain("<h1>Congrats, Rosa.");
    expect(mine[0]?.text).toContain("To stop these emails:");
    expect(mine[0]?.html).not.toContain("To stop these emails");
    const [first] = await rows(m);
    expect(first).toMatchObject({ status: "sent" });
    expect(first?.sent_at?.getTime()).toBe(sentAt.getTime());
    // 23 hours later: not yet, and the page knows when
    await run(at(23));
    expect(await rows(m)).toHaveLength(1);
    const waiting = await approvalRow(approvalId);
    expect(waiting.next_step).toBe(2);
    expect(waiting.next_email_at?.getTime()).toBe(sentAt.getTime() + 24 * H);
    // 24 hours after it SENT (not after it was queued): follow-up 1 goes
    await run(new Date(sentAt.getTime() + 24 * H));
    const after = await rows(m);
    expect(after.map((r) => r.source)).toEqual([
      `approval:${approvalId}:step:1`,
      `approval:${approvalId}:step:2`,
    ]);
    expect(after[1]).toMatchObject({ status: "queued", subject: "Follow-up 1, Rosa" });
    // running again does not queue it twice
    await run(new Date(sentAt.getTime() + 24 * H + 60_000));
    expect(await rows(m)).toHaveLength(2);
  });

  it("waits for the morning when a follow-up falls due at night", async () => {
    const m = await merchant();
    const { approvalId } = await approve(m);
    // sent at 2pm; follow-up 1 set to 10 hours: due at midnight, goes at 9am
    await drain(NOW);
    await t.pool.query("update approval_emails set delay_hours = 10 where step = 2");
    await run(at(10));
    const [, second] = await rows(m);
    expect(second?.not_before.toISOString()).toBe("2026-11-19T14:00:00.000Z");
    await t.pool.query("update approval_emails set delay_hours = 24 where step = 2");
    // and the worker does not send it before then
    sent.length = 0;
    await drain(at(11));
    expect(sent.filter((s) => s.to.startsWith(`owner${n}@`))).toHaveLength(0);
    expect((await approvalRow(approvalId)).next_step).toBe(2);
  });

  it("a delay changed in Settings applies to the next follow-up not yet queued", async () => {
    const m = await merchant();
    const { approvalId } = await approve(m);
    await drain(NOW);
    await t.db.withUser(boss, (q) => setApprovalDelay(q, 2, 3, boss));
    await run(at(3));
    expect((await rows(m)).map((r) => r.source)).toContain(`approval:${approvalId}:step:2`);
    await t.db.withUser(boss, (q) => setApprovalDelay(q, 2, 24, boss));
  });

  it("stops at the merchant's reply, and the worker cancels a step already queued", async () => {
    const m = await merchant();
    const { approvalId } = await approve(m);
    // the reply lands before the worker gets to the first email
    await reply(m);
    // an unverified email from that address (SPF or DKIM failed) is not a reply: the sync stores it as 'unknown'
    await t.pool.query("update inbound_emails set kind = 'unknown' where client_id = $1", [m]);
    const halt = () =>
      t.db.withSystem(
        async (q) =>
          (await q.query<{ h: string | null }>("select app.approval_halt($1) as h", [approvalId]))
            .rows[0]?.h,
      );
    expect(await halt()).toBeNull();
    await t.pool.query("update inbound_emails set kind = 'merchant' where client_id = $1", [m]);
    expect(await halt()).toBe("replied");
    await drain(at(0.1));
    expect(await rows(m)).toMatchObject([{ status: "cancelled", skip_reason: "replied" }]);
    await run(at(0.2));
    expect(await approvalRow(approvalId)).toMatchObject({
      status: "open",
      emails: "stopped",
      emails_note: "replied",
      next_step: null,
    });
    // a rep can start them again: the reply before the restart no longer counts
    const r = await resume(approvalId, rep, at(1));
    expect(r).toMatchObject({ kind: "queued", step: 1 });
  });

  it("Pitched takes it off the page and takes back the queued email", async () => {
    const m = await merchant();
    const { approvalId } = await approve(m);
    const before = await t.db.withUser(rep, (q) => openApprovalCount(q));
    await t.db.withUser(rep, (q) => markPitched(q, approvalId, ctx(rep)));
    expect(await approvalRow(approvalId)).toMatchObject({ status: "pitched", emails: "stopped" });
    expect(await rows(m)).toMatchObject([{ status: "cancelled", skip_reason: "pitched" }]);
    expect(await t.db.withUser(rep, (q) => openApprovalCount(q))).toBe(before - 1);
    const open = await t.db.withUser(rep, (q) => listApprovals(q, "open"));
    expect(open.some((a) => a.id === approvalId)).toBe(false);
    const pitched = await t.db.withUser(rep, (q) => listApprovals(q, "pitched"));
    expect(pitched.find((a) => a.id === approvalId)).toMatchObject({
      business_name: expect.any(String),
      pitched_by_name: "josh miller",
    });
    // Undo puts it back, emails stopped until Resume
    await t.db.withUser(rep, (q) => reopenApproval(q, approvalId, ctx(rep)));
    expect(await approvalRow(approvalId)).toMatchObject({ status: "open", emails: "stopped" });
  });

  it("Close records why; a merchant has one open approval at a time", async () => {
    const m = await merchant();
    const { approvalId } = await approve(m);
    await expect(approve(m)).rejects.toThrow(/already has an open approval/);
    await t.db.withUser(rep, (q) =>
      closeApproval(q, approvalId, "Went with another funder", ctx(rep)),
    );
    expect(
      await one("select status, closed_reason from approvals where id = $1", [approvalId]),
    ).toEqual({ status: "closed", closed_reason: "Went with another funder" });
    // a new offer can come in after that
    await expect(approve(m)).resolves.toMatchObject({ first: { kind: "queued" } });
  });

  it("Pause takes back the queued email; Resume sends an overdue step at once", async () => {
    const m = await merchant();
    const { approvalId } = await approve(m);
    await drain(NOW);
    await t.db.withUser(rep, (q) => pauseApprovalEmails(q, approvalId));
    await run(at(30));
    expect(await rows(m)).toHaveLength(1);
    expect(await approvalRow(approvalId)).toMatchObject({ emails: "paused" });
    const r = await resume(approvalId, rep, at(30));
    expect(r).toMatchObject({ kind: "queued", step: 2 });
  });

  it("finishes after the last email, filling in the hold date", async () => {
    const m = await merchant();
    const { approvalId } = await approve(m);
    // three weeks of the outbox cron at 2pm every day (weekends and Thanksgiving wait for the next weekday)
    let clock = NOW;
    for (let day = 0; day < 21; day += 1) {
      await run(clock);
      await drain(clock);
      clock = new Date(clock.getTime() + 24 * H);
    }
    const all = await rows(m);
    expect(all.map((r) => r.status)).toEqual(["sent", "sent", "sent", "sent"]);
    expect(all[3]?.html_body).toContain(`I can hold it until ${expiryWords(HOLD)}.`);
    await run(clock);
    expect(await approvalRow(approvalId)).toMatchObject({ emails: "finished", next_step: null });
  });

  it("stops when the hold date has passed, and for a merchant who opted out", async () => {
    const m1 = await merchant();
    const a1 = await approve(m1, rep, { holdUntil: "2026-01-02" });
    expect(a1.first).toMatchObject({ kind: "stopped", note: "expired" });
    expect(await rows(m1)).toHaveLength(0);
    const m2 = await merchant();
    const a2 = await approve(m2);
    await t.pool.query("update clients set email_opt_out = true where id = $1", [m2]);
    await drain(NOW);
    expect(await rows(m2)).toMatchObject([{ status: "skipped", skip_reason: "opted_out" }]);
    await run(at(1));
    expect(await approvalRow(a2.approvalId)).toMatchObject({
      emails: "stopped",
      emails_note: "opted_out",
    });
  });

  it("goes to a merchant who was handed off, and is not held by the sequence frequency limit", async () => {
    const m = await merchant();
    await t.pool.query("update clients set brought_in_at = now() where id = $1", [m]);
    // three automated emails already this week would stop a sequence step
    for (let i = 0; i < 3; i += 1)
      await t.pool.query(
        "insert into send_ledger (mailbox_id, client_id, lane, sent_at) values ((select id from mailboxes limit 1), $1, 'sequence', $2)",
        [m, at(-24 * (i + 1)).toISOString()],
      );
    await approve(m);
    await drain(NOW);
    expect(await rows(m)).toMatchObject([{ status: "sent" }]);
  });

  it("waits for the shop's postal address like every automated email", async () => {
    await t.pool.query("update shop_settings set postal_address = ''");
    const m = await merchant();
    await approve(m);
    await drain(NOW);
    expect(await rows(m)).toMatchObject([{ status: "queued" }]);
    expect(
      (await one<{ last_error: string }>("select last_error from outbox where client_id = $1", [m]))
        .last_error,
    ).toBe("no_postal_address");
    await t.pool.query(
      "update shop_settings set postal_address = '5301 N Federal Hwy, Boca Raton, FL 33487'",
    );
  });

  it("an edit re-fills a queued email with the new numbers", async () => {
    const m = await merchant();
    const { approvalId } = await approve(m);
    await t.db.withUser(rep, (q) =>
      editApproval(
        q,
        { approvalId, amount: 12_000_000, holdUntil: HOLD, funder: "", note: "" },
        ctx(rep),
      ),
    );
    await advanceApprovalNow(t.db, approvalId, ctx(rep));
    const all = await rows(m);
    expect(all.map((r) => r.status)).toEqual(["cancelled", "queued"]);
    expect(all[1]?.html_body).toContain("$120,000");
  });

  it("a rep cannot mark or see an approval for a merchant they cannot see; a manager can", async () => {
    const m = await merchant(other);
    await expect(approve(m, rep)).rejects.toThrow(/no longer exists/);
    const { approvalId } = await approve(m, boss);
    expect(
      (await t.db.withUser(rep, (q) => listApprovals(q, "open"))).some((a) => a.id === approvalId),
    ).toBe(false);
    expect(
      (await t.db.withUser(other, (q) => listApprovals(q, "open"))).some(
        (a) => a.id === approvalId,
      ),
    ).toBe(true);
    // the email comes from the merchant's own rep
    expect(
      (await one<{ user_id: string }>("select user_id from approvals where id = $1", [approvalId]))
        .user_id,
    ).toBe(other);
  });

  it("an approval marked 'hold the emails' sends nothing until Start", async () => {
    const m = await merchant();
    const { approvalId, first } = await approve(m, rep, { startEmails: false });
    expect(first).toBeNull();
    await run(at(2));
    expect(await rows(m)).toHaveLength(0);
    expect(await approvalRow(approvalId)).toMatchObject({ emails: "paused", emails_note: "held" });
    await t.db.withSystem((q) => advanceApproval(q, approvalId, { now: NOW, appUrl: APP }));
    expect(await rows(m)).toHaveLength(0);
  });

  it("stops for do-not-contact, the trash and a suppressed address; a bounce lifts when the address changes", async () => {
    const ms = [await merchant(), await merchant(), await merchant(), await merchant()];
    const [a, b, c, d] = ms as [string, string, string, string];
    const ids: string[] = [];
    for (const m of ms) ids.push((await approve(m)).approvalId);
    const emailOf = async (m: string) =>
      (await one<{ email: string }>("select email from clients where id = $1", [m])).email;
    await t.pool.query("update clients set contact_status = 'dnc' where id = $1", [a]);
    await t.pool.query("insert into trashed_clients (client_id, user_id) values ($1, $2)", [
      b,
      rep,
    ]);
    await t.pool.query(
      "select app.suppress('email', app.suppression_key($1), $1, 'complaint', '', null, null)",
      [await emailOf(c)],
    );
    await t.pool.query("update clients set email_bounced_at = now() where id = $1", [d]);
    await t.pool.query(
      "select app.suppress('email', app.suppression_key($1), $1, 'hard_bounce', '', $2, null)",
      [await emailOf(d), d],
    );
    await drain(NOW);
    await run(at(0.1));
    const notes: string[] = [];
    for (const id of ids) notes.push((await approvalRow(id)).emails_note);
    expect(notes).toEqual(["dnc", "trashed", "suppressed", "bounced"]);
    for (const m of ms) expect((await rows(m)).some((r) => r.status === "sent")).toBe(false);
    // the rep fixes the bounced address and resumes: it goes, to the new address
    await t.pool.query("update clients set email = 'fixed@shop.com' where id = $1", [d]);
    expect(await resume(ids[3] ?? "", rep, at(1))).toMatchObject({ kind: "queued" });
    expect(
      (
        await one<{ to_address: string }>(
          "select to_address from outbox where client_id = $1 and status = 'queued'",
          [d],
        )
      ).to_address,
    ).toBe("fixed@shop.com");
  });

  it("follows the merchant when their rep is offboarded: the queued email is taken back and filled again in the new rep's name", async () => {
    await t.pool.query(
      "update app_users set name = 'Dana Cruz', phone = '(305) 555-0177' where id = $1",
      [other],
    );
    const leaver = await insertUser(t.pool, "leaver@selectivecap.com");
    await t.pool.query(
      "update app_users set name = 'Lee Vers', phone = '(786) 555-0111' where id = $1",
      [leaver],
    );
    const m = await merchant(leaver);
    const { approvalId } = await approve(m, leaver);
    expect((await rows(m))[0]?.html_body).toContain("Lee Vers");
    // the manager offboards the leaver, handing the book to Dana
    await t.db.withUser(boss, (q) => q.query("select offboard_user($1, $2)", [leaver, other]));
    expect(await rows(m)).toMatchObject([{ status: "cancelled", skip_reason: "owner_changed" }]);
    expect(
      (await one<{ user_id: string }>("select user_id from approvals where id = $1", [approvalId]))
        .user_id,
    ).toBe(other);
    await run(NOW);
    const again = (await rows(m))[1];
    expect(again?.status).toBe("queued");
    expect(again?.html_body).toContain("Dana Cruz");
    expect(again?.html_body).not.toContain("Lee Vers");
    expect(again?.html_body).toContain("tel:+13055550177");
    expect(
      (
        await one<{ user_id: string }>(
          "select user_id from outbox where client_id = $1 and status = 'queued'",
          [m],
        )
      ).user_id,
    ).toBe(other);
    // a step queued in the old rep's name that slipped through is not sent: the worker checks the owner too
    await t.pool.query(
      "update outbox set user_id = $2 where client_id = $1 and status = 'queued'",
      [m, leaver],
    );
    await drain(NOW);
    expect((await rows(m)).map((r) => r.skip_reason)).toEqual(["owner_changed", "owner_changed"]);
  });

  it("takes back a queued email when the address changes, or approval emails are switched off", async () => {
    const m1 = await merchant();
    await approve(m1);
    await t.pool.query("update clients set email = 'right@shop.com' where id = $1", [m1]);
    await drain(NOW);
    expect(await rows(m1)).toMatchObject([{ status: "cancelled", skip_reason: "address_changed" }]);
    await run(NOW);
    expect(
      (
        await one<{ to_address: string }>(
          "select to_address from outbox where client_id = $1 and status = 'queued'",
          [m1],
        )
      ).to_address,
    ).toBe("right@shop.com");

    const m2 = await merchant();
    const { approvalId } = await approve(m2);
    await t.pool.query("update shop_settings set approval_emails_on = false");
    await drain(NOW);
    expect(await rows(m2)).toMatchObject([{ status: "cancelled", skip_reason: "turned_off" }]);
    await run(at(1));
    expect(await approvalRow(approvalId)).toMatchObject({
      emails: "running",
      emails_note: "turned_off",
    });
    expect(await rows(m2)).toHaveLength(1);
    await t.pool.query("update shop_settings set approval_emails_on = true");
    await run(at(1));
    expect((await rows(m2)).map((r) => r.status)).toEqual(["cancelled", "queued"]);
  });

  it("a send the worker only reaches at night waits for the merchant's morning", async () => {
    const m = await merchant();
    await approve(m);
    // the worker only gets to it at 10pm in Florida (Gmail was down, a run was missed): not now, at 9am
    await drain(at(8));
    const [r] = await rows(m);
    expect(r?.status).toBe("queued");
    expect(r?.not_before.toISOString()).toBe("2026-11-19T14:00:00.000Z");
    expect(
      (await one<{ last_error: string }>("select last_error from outbox where client_id = $1", [m]))
        .last_error,
    ).toBe("outside_window");
  });

  it("one approval that cannot be checked fails alone; the rest of the outbox still sends", async () => {
    const bad = await merchant();
    await approve(bad);
    await t.pool.query("update clients set timezone = 'Mars/Olympus_Mons' where id = $1", [bad]);
    const fine = await merchant();
    await approve(fine);
    await drain(NOW);
    expect((await rows(bad)).map((r) => r.status)).toEqual(["failed"]);
    expect((await rows(fine)).map((r) => r.status)).toEqual(["sent"]);
    // the engine's pass over every approval reports it and carries on
    const summary = await run(at(1));
    expect(summary.errors).toBeGreaterThanOrEqual(1);
    expect(summary.checked).toBeGreaterThan(1);
    await t.pool.query("update clients set timezone = null where id = $1", [bad]);
  });

  it("goes from the rep's own Gmail even when the shop's domain is set; replies always reach the rep", async () => {
    // dns_ok resets whenever the sender changes (0503), so the check passes in a second statement
    await t.pool.query(
      "update shop_settings set automation_from = 'auto@mail.selectivecap.com', automation_reply_to_rep = false",
    );
    await t.pool.query("update shop_settings set dns_ok = true");
    const viaGmail = await merchant();
    await approve(viaGmail);
    // a rep with no Gmail connected: the shop's domain, with the rep as reply-to
    const noGmail = await insertUser(t.pool, "nogmail@selectivecap.com");
    await t.pool.query(
      "update app_users set name = 'Ana Ruiz', phone = '3055550100' where id = $1",
      [noGmail],
    );
    const viaResend = await merchant(noGmail);
    await approve(viaResend, noGmail);
    const seen: { replyTo?: string; to: string }[] = [];
    await drainOutbox({
      db: t.db,
      now: NOW,
      appUrl: APP,
      deliver: {
        gmail: async (_u, m) => (seen.push(m), "g"),
        resend: async (m) => (seen.push(m), "r"),
      },
    });
    const provider = async (m: string) =>
      (
        await one<{ provider: string }>(
          "select provider from outbox where client_id = $1 and status = 'sent'",
          [m],
        )
      ).provider;
    expect(await provider(viaGmail)).toBe("gmail");
    expect(await provider(viaResend)).toBe("resend");
    expect(seen.find((x) => x.to.startsWith(`owner${n}@`))?.replyTo).toBe(
      "nogmail@selectivecap.com",
    );
    await t.pool.query(
      "update shop_settings set automation_from = '', dns_ok = false, automation_reply_to_rep = true",
    );
  });

  it("a design without the shop's postal address gets the footer added inside it", async () => {
    await t.pool.query(
      "update shop_settings set postal_address = '77 Ocean Dr, Miami Beach, FL 33139'",
    );
    const m = await merchant();
    await approve(m);
    sent.length = 0;
    await drain(NOW);
    const html = sent.find((x) => x.to.startsWith(`owner${n}@`))?.html ?? "";
    expect(html).toContain("77 Ocean Dr, Miami Beach, FL 33139");
    expect(html.indexOf("77 Ocean Dr")).toBeLessThan(html.indexOf("</body>"));
    await t.pool.query(
      "update shop_settings set postal_address = '5301 N Federal Hwy, Boca Raton, FL 33487'",
    );
    // with the address in the design, nothing is added
    const m2 = await merchant();
    await approve(m2);
    sent.length = 0;
    await drain(NOW);
    expect(sent.find((x) => x.to.startsWith(`owner${n}@`))?.html).not.toContain(
      "To stop these emails",
    );
  });

  it("a merchant who answers after the last email still comes first, until someone calls", async () => {
    const m = await merchant();
    const { approvalId } = await approve(m);
    await t.pool.query("update approvals set emails = 'finished' where id = $1", [approvalId]);
    const needsCall = async () =>
      (await t.db.withUser(rep, (q) => listApprovals(q, "open"))).find((a) => a.id === approvalId)
        ?.needs_call;
    expect(await needsCall()).toBe(false);
    await reply(m);
    expect(await needsCall()).toBe(true);
    const list = await t.db.withUser(rep, (q) => listApprovals(q, "open"));
    expect(list[0]?.id).toBe(approvalId);
    expect((await t.db.withUser(rep, (q) => approvalStats(q))).replied).toBeGreaterThanOrEqual(1);
    // a call logged after the reply clears it
    await t.pool.query(
      "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'call', 'Talked')",
      [rep, m],
    );
    expect(await needsCall()).toBe(false);
    // and a reply from before the emails restarted never counted
    const m2 = await merchant();
    await reply(m2);
    const a2 = await approve(m2);
    expect(
      (await t.db.withUser(rep, (q) => listApprovals(q, "open"))).find(
        (a) => a.id === a2.approvalId,
      )?.needs_call,
    ).toBe(false);
  });

  it("Undo after Pitched puts the emails back as they were; Reopen later leaves them stopped", async () => {
    const running = await merchant();
    const held = await merchant();
    const a = await approve(running);
    const b = await approve(held, rep, { startEmails: false });
    await t.db.withUser(rep, (q) => markPitched(q, a.approvalId, ctx(rep)));
    await t.db.withUser(rep, (q) => markPitched(q, b.approvalId, ctx(rep)));
    await t.db.withUser(rep, (q) => reopenApproval(q, a.approvalId, ctx(rep), true));
    await t.db.withUser(rep, (q) => reopenApproval(q, b.approvalId, ctx(rep), true));
    expect(await approvalRow(a.approvalId)).toMatchObject({
      status: "open",
      emails: "running",
      emails_note: "",
    });
    // the held one comes back held, not started
    expect(await approvalRow(b.approvalId)).toMatchObject({
      status: "open",
      emails: "paused",
      emails_note: "held",
    });
    // the same pitch, reopened from the Pitched tab later: stopped until Resume
    await t.db.withUser(rep, (q) => markPitched(q, a.approvalId, ctx(rep)));
    await t.db.withUser(rep, (q) => reopenApproval(q, a.approvalId, ctx(rep)));
    expect(await approvalRow(a.approvalId)).toMatchObject({
      emails: "stopped",
      emails_note: "reopened",
    });
  });

  it("changing or removing a design takes back the email already queued from it", async () => {
    await t.pool.query("update approval_emails set delay_hours = 1 where step = 2");
    const m = await merchant();
    const { approvalId } = await approve(m);
    await drain(NOW);
    await run(at(1.1));
    expect((await rows(m)).map((r) => r.status)).toEqual(["sent", "queued"]);
    await t.db.withUser(boss, (q) =>
      saveApprovalDesign(
        q,
        {
          step: 2,
          subject: "Newer wording, {{first_name}}",
          html: design("x", "<p>New</p>"),
          fileName: "",
        },
        boss,
      ),
    );
    expect((await rows(m)).map((r) => r.skip_reason)).toEqual([null, "design_changed"]);
    await run(at(1.2));
    const again = await rows(m);
    expect(again.at(-1)).toMatchObject({ status: "queued", subject: "Newer wording, Rosa" });
    // removing the design leaves the email waiting, not sending the old one
    await t.db.withUser(boss, (q) => clearApprovalDesign(q, 2, boss));
    expect((await rows(m)).at(-1)?.skip_reason).toBe("design_changed");
    await run(at(1.3));
    expect((await approvalRow(approvalId)).emails_note).toBe("no_design");
    await t.db.withUser(boss, (q) =>
      saveApprovalDesign(
        q,
        { step: 2, subject: "Follow-up 1, {{first_name}}", html: design("x"), fileName: "" },
        boss,
      ),
    );
    await t.pool.query("update approval_emails set delay_hours = 24 where step = 2");
  });
});
