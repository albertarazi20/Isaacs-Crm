import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SplitResult } from "@/lib/ai/splitLeadLine";
import { applicationEmail } from "@/lib/leads/applicationEmail";
import { merchantApplication } from "@/lib/leads/application";
import { assistantRefusal, assistantState } from "@/lib/leads/assistant";
import { applySplit, type PasteValues } from "@/lib/leads/paste";
import { listStagedRows } from "@/lib/leads/staged";
import { loadMemberMeta } from "@/lib/messaging/memberMeta";
import { pausedLabel, replyChip } from "@/lib/messaging/replyTagLabels";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/** The read side and the pure parts of the intake, follow-up and merchant-page controls. */

const blank: SplitResult = {
  first_name: "",
  last_name: "",
  business_name: "",
  phone: "",
  phone2: "",
  email: "",
  email2: "",
  industry: "",
  state: "",
  wanted_amount: "",
  looking_for: "",
  notes: "",
};
const form: PasteValues = {
  firstName: "",
  lastName: "",
  businessName: "",
  phone: "",
  email: "",
  phone2: "",
  email2: "",
  industry: "",
  state: "",
  lookingFor: "",
  wantedAmount: "",
};

describe("paste a lead line: what goes into the form", () => {
  it("fills what the line says, names it, and leaves the rest as typed", () => {
    const out = applySplit(
      { ...form, industry: "Restaurant", state: "FL" },
      {
        ...blank,
        first_name: " Rosa ",
        last_name: "Lind",
        business_name: "Harbor Tacos",
        phone: "(310) 555-0142",
        email: "rosa@harbortacos.com",
        state: "CA",
        wanted_amount: "60k",
        looking_for: "a second truck",
      },
    );
    expect(out.next).toEqual({
      ...form,
      firstName: "Rosa",
      lastName: "Lind",
      businessName: "Harbor Tacos",
      phone: "(310) 555-0142",
      email: "rosa@harbortacos.com",
      industry: "Restaurant",
      state: "CA",
      wantedAmount: "60k",
      lookingFor: "a second truck",
    });
    expect(out.filled).toEqual([
      "First name",
      "Last name",
      "Business",
      "Phone",
      "Email",
      "State",
      "Amount they want",
      "What they are looking for",
    ]);
    expect(out.warning).toBeNull();
  });

  it("keeps the notes line with what they are looking for, and warns when there is no phone", () => {
    const both = applySplit(form, { ...blank, looking_for: "a truck", notes: "call after 3pm" });
    expect(both.next.lookingFor).toBe("a truck\ncall after 3pm");
    const notesOnly = applySplit(form, { ...blank, notes: "call after 3pm" });
    expect(notesOnly.next.lookingFor).toBe("call after 3pm");
    expect(notesOnly.filled).toEqual(["What they are looking for"]);
    expect(notesOnly.warning).toBe("No phone number in that line — add it below.");
  });

  it("a line that says nothing changes nothing", () => {
    const typed = { ...form, phone: "3055550100", businessName: "E2E Cafe" };
    const out = applySplit(typed, blank);
    expect(out.next).toEqual(typed);
    expect(out.filled).toEqual([]);
  });
});

describe("whether the assistant can run", () => {
  it("names the first reason it cannot, in the words the action refuses with", () => {
    const ok = { keySet: true, enabled: true, capCents: 500, spentCents: 100 };
    expect(assistantRefusal(ok)).toBeNull();
    expect(assistantRefusal({ ...ok, keySet: false, enabled: false })).toBe(
      "The assistant is not set up on this server",
    );
    expect(assistantRefusal({ ...ok, enabled: false })).toBe(
      "The assistant is switched off in Settings",
    );
    expect(assistantRefusal({ ...ok, spentCents: 500 })).toMatch(/used today's budget/);
  });
});

describe("the chips on a lead line", () => {
  it("a chip for each reply tag, with the revive date on not-now; none for other", () => {
    const today = "2026-11-16";
    expect(replyChip("interested", null, today)).toEqual({ label: "Interested", tone: "good" });
    expect(replyChip("sending_docs", null, today)).toEqual({
      label: "Sending docs",
      tone: "info",
    });
    expect(replyChip("not_now", "2026-11-30", today)).toEqual({
      label: "Not now — back Nov 30",
      tone: "warn",
    });
    expect(replyChip("not_now", "2027-01-05", today)?.label).toBe("Not now — back Jan 5, 2027");
    expect(replyChip("not_now", null, today)?.label).toBe("Not now");
    expect(replyChip("wrong_person", null, today)).toEqual({ label: "Wrong person", tone: "bad" });
    expect(replyChip("stop", null, today)).toEqual({ label: "Stop", tone: "bad" });
    expect(replyChip("other", null, today)).toBeNull();
    expect(replyChip(null, null, today)).toBeNull();
  });
  it("the pause label carries the day, or is plain Paused", () => {
    expect(pausedLabel("2026-11-30", "2026-11-16")).toBe("Paused until Nov 30");
    expect(pausedLabel(null, "2026-11-16")).toBe("Paused");
  });
});

describe("the email that carries the application link", () => {
  it("greets by first name (an honorific stays), names the business and carries the link once", () => {
    const e = applicationEmail({
      contactName: "Dr. Anna Weiss",
      businessName: "Weiss Dental",
      link: "https://crm.test/apply/abc",
    });
    expect(e.subject).toBe("Your application — Weiss Dental");
    expect(e.body.startsWith("Hi Dr. Weiss,")).toBe(true);
    expect(e.body.split("https://crm.test/apply/abc")).toHaveLength(2);
    expect(applicationEmail({ contactName: "", businessName: "X", link: "l" }).body).toMatch(
      /^Hi,\n/,
    );
  });
});

let t: TestDb;
let mike: string;
let dana: string;
let boss: string;
let statements: string;

const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await t.pool.query<T>(sql, params)).rows[0];

describe("database reads", () => {
  beforeAll(async () => {
    t = await createTestDb();
    mike = await insertUser(t.pool, "mike@x.com");
    dana = await insertUser(t.pool, "dana@x.com");
    boss = await insertUser(t.pool, "boss@x.com");
    await t.pool.query("update app_users set role = 'manager' where id = $1", [boss]);
    statements = (await one<{ id: string }>(
      "select id from buckets where key = 'missing_statements'",
    ))!.id;
  });
  afterAll(async () => {
    await t.drop();
  });

  describe("bulk intake: the staged rows a person may file", () => {
    let danas: string;
    let shared: string;
    let off: string;
    const source = async (owner: string | null, name: string, active = true) =>
      (await one<{ id: string }>(
        `insert into sheet_sources (owner_id, name, spreadsheet_id, sheet_title, mapping, target_bucket_id, active)
         values ($1, $2, $2, 'Nov', '{}', $3, $4) returning id`,
        [owner, name, statements, active],
      ))!.id;
    const row = async (src: string, n: number, name: string, phone: string) =>
      (await one<{ id: string }>(
        `insert into sheet_rows (source_id, row_no, phone_key, business_name, phone, row_hash)
         values ($1, $2::int, right(regexp_replace($4::text, '\\D', '', 'g'), 10), $3, $4::text, md5($2::text)) returning id`,
        [src, n, name, phone],
      ))!.id;

    beforeAll(async () => {
      danas = await source(dana, "Dana vendor");
      const mikes = await source(mike, "Mike vendor");
      shared = await source(null, "Shop vendor");
      off = await source(dana, "Old vendor", false);
      await row(danas, 1, "Blue Bakery", "2125550190");
      const filed = await row(danas, 2, "Filed Already", "2125550191");
      await t.pool.query("update sheet_rows set filed_at = now() where id = $1", [filed]);
      await row(mikes, 1, "Mike's Row", "2125550192");
      await row(shared, 1, "Shared Row", "2125550193");
      await row(off, 1, "Inactive Row", "2125550194");
    });

    it("a rep sees only the unfiled rows of an active sheet they own", async () => {
      const r = await t.db.withUser(dana, (q) => listStagedRows(q));
      expect(r.rows.map((x) => x.business_name)).toEqual(["Blue Bakery"]);
      expect(r.total).toBe(1);
      expect(r.rows[0]).toMatchObject({
        source_name: "Dana vendor",
        target_bucket_id: statements,
        target_bucket_name: "Missing statements",
        phone: "2125550190",
      });
      expect(r.rows[0]?.first_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it("a manager sees every active sheet's unfiled rows; the limit caps the list, not the count", async () => {
      const all = await t.db.withUser(boss, (q) => listStagedRows(q));
      expect(all.rows.map((x) => x.business_name).sort()).toEqual([
        "Blue Bakery",
        "Mike's Row",
        "Shared Row",
      ]);
      expect(all.total).toBe(3);
      const capped = await t.db.withUser(boss, (q) => listStagedRows(q, 2));
      expect(capped.rows).toHaveLength(2);
      expect(capped.total).toBe(3);
    });
  });

  describe("the lead lines' reply tag and pause date", () => {
    let a: string;
    let b: string;
    let c: string;
    const merchant = async (name: string, phone: string) => {
      const id = (await one<{ id: string }>(
        "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Rosa', $3, $4, 'FL') returning id",
        [dana, name, phone, `${name.replace(/\W/g, "").toLowerCase()}@x.com`],
      ))!.id;
      await t.pool.query("select enroll_in_bucket($1, $2)", [id, statements]);
      return id;
    };
    const reply = async (clientId: string, n: number, tag: string, days: number | null) => {
      const email = (await one<{ id: string }>(
        `insert into inbound_emails (mailbox_user_id, gmail_id, gmail_thread_id, from_address, from_name, subject, snippet, text_body,
                                     received_at, client_id, matched_by, kind)
         values ($1, $2, 'th', 'r@x.com', 'Rosa', 'Re', 's', 'b', now(), $3, 'merchant_reply', 'merchant') returning id`,
        [dana, `g-${clientId}-${n}`, clientId],
      ))!.id;
      await t.pool.query("select apply_reply_tag($1, $2, 0.9, 'in their words', true, 'm', $3)", [
        email,
        tag,
        days,
      ]);
    };

    beforeAll(async () => {
      a = await merchant("Alpha Co", "3055550101");
      b = await merchant("Beta Co", "3055550102");
      c = await merchant("Gamma Co", "3055550103");
      await reply(a, 1, "interested", null);
      await reply(b, 1, "not_now", 14);
      // the latest reply wins: interested first, then wrong person
      await reply(c, 1, "interested", null);
      await t.pool.query(
        "update reply_tags set created_at = now() - interval '2 days' where client_id = $1",
        [c],
      );
      await reply(c, 2, "wrong_person", null);
      // a hand pause with a date, and one without
      await t.pool.query("select set_enrollment_paused($1, true)", [a]);
      await t.pool.query(
        "update enrollments set resume_on = current_date + 9 where client_id = $1 and stopped_at is null",
        [a],
      );
    });

    it("one row per merchant: the latest tag with its words, and the day a pause lifts", async () => {
      const today = t.today;
      const meta = await t.db.withUser(dana, (q) => loadMemberMeta(q, [a, b, c]));
      expect(meta[a]).toMatchObject({
        tag: "interested",
        quote: "in their words",
        supported: true,
        tag_revive_on: null,
      });
      expect(meta[a]?.resume_on).not.toBeNull();
      expect(meta[b]?.tag).toBe("not_now");
      expect(meta[b]?.tag_revive_on).not.toBeNull();
      // not-now pauses the enrolment until the day it names
      expect(meta[b]?.resume_on).toBe(meta[b]?.tag_revive_on);
      expect((meta[b]?.resume_on ?? "") > today).toBe(true);
      expect(meta[c]?.tag).toBe("wrong_person");
      expect(meta[c]?.tag_at).toMatch(/Z$/);
    });

    it("a merchant with no reply has no tag; an empty list reads nothing; another rep's rows are not visible", async () => {
      const d = await merchant("Delta Co", "3055550104");
      const meta = await t.db.withUser(dana, (q) => loadMemberMeta(q, [d]));
      expect(meta[d]).toMatchObject({ tag: null, quote: "", resume_on: null });
      expect(await t.db.withUser(dana, (q) => loadMemberMeta(q, []))).toEqual({});
      expect(await t.db.withUser(mike, (q) => loadMemberMeta(q, [a, b, c]))).toEqual({});
    });
  });

  describe("the merchant's application", () => {
    let m: string;
    beforeAll(async () => {
      m = (await one<{ id: string }>(
        "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Harbor Tacos', 'Rosa Diaz', '3105550199', 'r@h.com', 'CA') returning id",
        [mike],
      ))!.id;
    });

    it("gives the token behind the link; nothing signed yet, no deal", async () => {
      const token = (await one<{ application_token: string }>(
        "select application_token from clients where id = $1",
        [m],
      ))!.application_token;
      const a = await t.db.withUser(mike, (q) => merchantApplication(q, m));
      expect(a).toEqual({ token, latest: null, deal_id: null });
    });

    it("the newest signed application with its PDF, and the deal whose Documents hold it", async () => {
      const deal = (await one<{ id: string }>(
        "insert into deals (user_id, client_id) values ($1, $2) returning id",
        [mike, m],
      ))!.id;
      const doc = (await one<{ id: string }>(
        `insert into documents (user_id, client_id, deal_id, kind, filename, content_type, size_bytes, sha256, storage_key, source)
         values ($1, $2, $3, 'signed_application', 'application.pdf', 'application/pdf', 10, repeat('a', 64), 'k1', 'upload_link') returning id`,
        [mike, m, deal],
      ))!.id;
      await t.pool.query(
        `insert into applications (client_id, user_id, deal_id, document_id, fields, signer_name, signed_at)
         values ($1, $2, null, null, '{}', 'Older Signer', now() - interval '3 days'),
                ($1, $2, $3, $4, '{}', 'Rosa Diaz', now())`,
        [m, mike, deal, doc],
      );
      const a = await t.db.withUser(mike, (q) => merchantApplication(q, m));
      expect(a?.latest).toMatchObject({ signer_name: "Rosa Diaz", document_id: doc });
      expect(a?.latest?.signed_at).toMatch(/Z$/);
      expect(a?.deal_id).toBe(deal);
      // another rep cannot open it
      expect(await t.db.withUser(dana, (q) => merchantApplication(q, m))).toBeNull();
    });
  });

  describe("assistantState reads the shop's AI settings", () => {
    it("no key: not set up, without reading the database; a key with the switch on and budget left: ready", async () => {
      expect(await t.db.withUser(dana, (q) => assistantState(q, false))).toEqual({
        ready: false,
        reason: "The assistant is not set up on this server",
      });
      expect(await t.db.withUser(dana, (q) => assistantState(q, true))).toEqual({
        ready: true,
        reason: "",
      });
      await t.pool.query("update shop_settings set ai_enabled = false");
      expect(await t.db.withUser(dana, (q) => assistantState(q, true))).toEqual({
        ready: false,
        reason: "The assistant is switched off in Settings",
      });
      await t.pool.query("update shop_settings set ai_enabled = true, ai_daily_cap_cents = 0");
      expect((await t.db.withUser(dana, (q) => assistantState(q, true))).ready).toBe(false);
    });
  });
});
