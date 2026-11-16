import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toActionError } from "@/lib/data/errors";
import { termsUpdateSchema } from "@/lib/earnings/schemas";
import { buildRadar } from "@/lib/earnings/radar";
import { BACKUP_TABLES, buildBackup, type Backup } from "@/lib/export/backup";
import { restoreBackup } from "@/lib/export/restore";
import { parseCommissionText } from "@/lib/earnings/commission";
import {
  blockingErrors,
  changedTermsPayload,
  checkTerms,
  switchCommissionMode,
  termsForm,
  type EditableFunding,
} from "@/lib/earnings/terms";
import {
  checkFunding,
  undoInput,
  wroteRecord,
  type FundingForm,
} from "@/components/stage-move/forms";
import { addDays } from "@/lib/mca/dates";
import type { ClientCard } from "@/lib/data/types";
import { createTestDb, insertClient, insertUser, timersJson, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
const d = (n: number) => addDays(t.today, n);

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "UTC");
});
afterAll(async () => {
  await t.drop();
});

type Q = Parameters<Parameters<typeof t.db.withUser>[1]>[0];
const asA = <T>(fn: (q: Q) => Promise<T>) => t.db.withUser(a, fn);
let seq = 0;

async function merchant(name: string, stage = "application_in") {
  seq += 1;
  const id = await insertClient(t.db, a, `${name} ${seq}`);
  await asA((q) =>
    q.query("select * from move_client($1, $2, $3::jsonb)", [
      id,
      stage,
      timersJson({ kind: "follow_up", due_on: d(2) }),
    ]),
  );
  return id;
}
async function funder(name: string) {
  seq += 1;
  const { rows } = await t.pool.query<{ id: string }>(
    "insert into funders (user_id, name) values ($1, $2) returning id",
    [a, `${name} ${seq}`],
  );
  return rows[0]?.id as string;
}
/** A merchant with two submissions, each with an offer, and the first offer accepted. */
async function acceptedDeal() {
  const id = await merchant("Accepted deal");
  const fs = [await funder("RA"), await funder("RB")];
  const subs = (
    await asA((q) =>
      q.query<{ id: string }>("select * from create_submissions($1, $2::uuid[], null, '')", [
        id,
        fs,
      ]),
    )
  ).rows.map((r) => r.id);
  const offers: string[] = [];
  for (const s of subs)
    offers.push(
      (
        await asA((q) =>
          q.query<{ id: string }>("select * from record_offer($1, $2::jsonb)", [
            s,
            JSON.stringify({ amount_cents: 2_000_000, factor_rate: 1.3 }),
          ]),
        )
      ).rows[0]?.id as string,
    );
  await asA((q) => q.query("select * from accept_offer($1)", [offers[0]]));
  return { id, subs: subs as [string, string], offers: offers as [string, string] };
}
const statusOf = async (id: string) =>
  (
    await t.pool.query<{ status: string; declined_by: string | null }>(
      "select status, declined_by from offers where id = $1",
      [id],
    )
  ).rows[0];

describe("C-1: removing the accepted offer (or its submission) works and brings the others back", () => {
  it("Remove offer on the accepted one", async () => {
    const { offers } = await acceptedDeal();
    expect((await statusOf(offers[1]))?.status).toBe("declined");
    await asA((q) => q.query("select remove_offer($1)", [offers[0]]));
    expect((await t.pool.query("select 1 from offers where id = $1", [offers[0]])).rowCount).toBe(
      0,
    );
    expect(await statusOf(offers[1])).toEqual({ status: "open", declined_by: null });
  });
  it("Remove submission on the accepted one's submission", async () => {
    const { id, subs, offers } = await acceptedDeal();
    await asA((q) => q.query("select remove_submission($1)", [subs[0]]));
    expect(
      (await t.pool.query("select 1 from submissions where id = $1", [subs[0]])).rowCount,
    ).toBe(0);
    expect(await statusOf(offers[1])).toEqual({ status: "open", declined_by: null });
    const { rows } = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and body like 'Removed the submission%'",
      [id],
    );
    expect(rows).toHaveLength(1);
  });
  it("removing an offer logs it, and a missing one is told so", async () => {
    const { id, offers } = await acceptedDeal();
    await asA((q) => q.query("select remove_offer($1)", [offers[1]]));
    const { rows } = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and body like 'Removed % offer%'",
      [id],
    );
    expect(rows).toHaveLength(1);
    await expect(asA((q) => q.query("select remove_offer($1)", [offers[1]]))).rejects.toThrow(
      /no longer exists/,
    );
  });
  it("merging when the dropped card's accepted offer is a deleted duplicate no longer fails", async () => {
    const keep = await merchant("Merge keep");
    const drop = await merchant("Merge drop");
    const f1 = await funder("MF1");
    const f2 = await funder("MF2");
    const sendTo = (client: string, fs: string[]) =>
      asA((q) =>
        q.query<{ id: string }>("select * from create_submissions($1, $2::uuid[], $3::date, '')", [
          client,
          fs,
          d(-1),
        ]),
      );
    await sendTo(keep, [f1]);
    const dropSubs = (await sendTo(drop, [f1, f2])).rows;
    const offer = async (s: string, factor: number) =>
      (
        await asA((q) =>
          q.query<{ id: string }>("select * from record_offer($1, $2::jsonb)", [
            s,
            JSON.stringify({ amount_cents: 1_000_000, factor_rate: factor }),
          ]),
        )
      ).rows[0]?.id as string;
    const accepted = await offer(dropSubs[0]?.id as string, 1.3); // the duplicate submission: it will be deleted
    const sibling = await offer(dropSubs[1]?.id as string, 1.35); // moves over
    await asA((q) => q.query("select * from accept_offer($1)", [accepted]));
    await asA((q) => q.query("select * from merge_clients($1, $2)", [keep, drop]));
    expect(await statusOf(sibling)).toEqual({ status: "open", declined_by: null });
  });
});

describe("C-2: a backup is one snapshot", () => {
  it("every row in a backup taken while another connection is writing has its parent in the same file", async () => {
    let stop = false;
    const writer = (async () => {
      while (!stop) {
        const id = await insertClient(t.db, a, `Writer ${(seq += 1)}`);
        await t.pool.query(
          "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'note', 'while backing up')",
          [a, id],
        );
      }
    })();
    try {
      for (let i = 0; i < 25; i += 1) {
        const b = await t.db.withUser(a, (q) => buildBackup(q));
        const ids = new Set((b.tables.clients ?? []).map((c) => c.id));
        for (const name of [
          "activities",
          "timers",
          "client_asks",
          "fundings",
          "submissions",
          "offers",
        ]) {
          const orphans = (b.tables[name] ?? []).filter((r) => !ids.has(r.client_id));
          expect(orphans.length, `${name} rows without their merchant in the same file`).toBe(0);
        }
      }
    } finally {
      stop = true;
      await writer;
    }
  });
});

const card = (over: Partial<ClientCard> = {}): ClientCard =>
  ({
    id: "c1",
    stage: "interested",
    funding_id: null,
    next_due_on: "2026-10-26",
    defaulted_on: null,
    promise_to_pay_at: null,
    promise_amount_cents: null,
    ...over,
  }) as ClientCard;

describe("C-3: no Undo for a move that booked a call", () => {
  it("wroteRecord counts callAt, funding and competitor; undoInput then offers nothing", () => {
    expect(wroteRecord({ callAt: "2026-10-25T10:30" })).toBe(true);
    expect(wroteRecord({ funding: {} })).toBe(true);
    expect(wroteRecord({ competitor: {} })).toBe(true);
    expect(wroteRecord({})).toBe(false);
    expect(
      undoInput(card(), "call_scheduled", wroteRecord({ callAt: "x" }), {
        today: "2026-10-23",
        timezone: "UTC",
      }),
    ).toBeNull();
    expect(
      undoInput(card(), "call_scheduled", wroteRecord({}), {
        today: "2026-10-23",
        timezone: "UTC",
      }),
    ).not.toBeNull();
  });
});

const funding = (over: Partial<EditableFunding> = {}): EditableFunding => ({
  id: "11111111-1111-4111-8111-111111111111",
  funded_on: "2026-10-01",
  funder_name: "Alpha",
  amount_cents: 5_000_000,
  factor_rate: 1.32,
  payback_cents: 6_600_000,
  payment_cents: 55_000,
  frequency: "daily",
  position_no: 1,
  term_days: null,
  commission_cents: 253_300,
  paid_back_override_cents: null,
  status: "active",
  defaulted_on: null,
  last_payment_on: null,
  promise_to_pay_at: null,
  promise_amount_cents: null,
  note: "",
  commission_received_cents: null,
  commission_received_on: null,
  ...over,
});

describe("C-4: flipping Dollars/Points never changes the money", () => {
  const TODAY = "2026-10-23";
  it("$2,533 → points → dollars saves exactly $2,533, and a toggle alone sends nothing", () => {
    const f = funding();
    const before = termsForm(f, "UTC");
    const bc = checkTerms(before, TODAY).commissionCents;
    expect(bc).toBe(253_300);
    const pts = switchCommissionMode(before, "points");
    expect(pts.commission).toBe("5.07");
    expect(checkTerms(pts, TODAY).commissionCents).toBe(253_300); // not 5.07 points = $2,535
    const back = switchCommissionMode(pts, "dollars");
    expect(checkTerms(back, TODAY).commissionCents).toBe(253_300);
    expect(
      changedTermsPayload(
        f.id,
        { form: pts, commissionCents: checkTerms(pts, TODAY).commissionCents },
        { form: before, commissionCents: bc },
      ),
    ).toBeNull();
    expect(
      changedTermsPayload(
        f.id,
        { form: back, commissionCents: checkTerms(back, TODAY).commissionCents },
        { form: before, commissionCents: bc },
      ),
    ).toBeNull();
  });
  it("typing after the switch is a real edit", () => {
    const before = termsForm(funding(), "UTC");
    const pts = { ...switchCommissionMode(before, "points"), commission: "6" };
    expect(checkTerms(pts, TODAY).commissionCents).toBe(300_000);
  });
});

describe("C-5 and C-13: restore brings the settings back and wants an empty account", () => {
  it("time zone, signature, application link and digest settings are restored; a non-empty account is refused", async () => {
    const src = await createTestDb();
    const dst = await createTestDb();
    try {
      const u = await insertUser(src.pool, "src@x.com", "America/Chicago");
      await src.pool.query(
        "update app_users set signature = 'Best, Isaac', application_link = 'https://apply.example.com/x', digest_hour = 7 where id = $1",
        [u],
      );
      await insertClient(src.db, u, "Settings Pizza");
      const backup = JSON.parse(
        JSON.stringify(await src.db.withUser(u, (q) => buildBackup(q))),
      ) as Backup;
      const target = await insertUser(dst.pool, "dst@x.com", "UTC");
      const client = await dst.pool.connect();
      try {
        await client.query("begin");
        await restoreBackup(client, backup, target);
        await client.query("commit");
      } finally {
        client.release();
      }
      const { rows } = await dst.pool.query(
        "select timezone, signature, application_link, digest_hour, email from app_users where id = $1",
        [target],
      );
      expect(rows[0]).toMatchObject({
        timezone: "America/Chicago",
        signature: "Best, Isaac",
        application_link: "https://apply.example.com/x",
        digest_hour: 7,
        email: "dst@x.com", // the sign-in address is the account's own, never the file's
      });
      // an account with only a funder in it is not empty
      const other = await insertUser(dst.pool, "other@x.com", "UTC");
      await dst.pool.query("insert into funders (user_id, name) values ($1, 'Already here')", [
        other,
      ]);
      const c2 = await dst.pool.connect();
      try {
        await expect(restoreBackup(c2, backup, other)).rejects.toThrow(/already has funders/);
      } finally {
        c2.release();
      }
    } finally {
      await src.drop();
      await dst.drop();
    }
  });
});

describe("C-6: an older backup still restores after a new column with a default", () => {
  it("restore_rows takes the column list from the file", async () => {
    const x = await createTestDb();
    try {
      const u = await insertUser(x.pool, "x@x.com", "UTC");
      await x.pool.query("alter table snippets add column pinned boolean not null default false");
      const n = await x.pool.query<{ n: number }>(
        "select app.restore_rows('snippets', $1::jsonb) as n",
        [
          JSON.stringify([
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              user_id: u,
              title: "Hi",
              kind: "text",
              body: "Hi there",
              sort: 0,
              created_at: "2026-10-01T00:00:00Z",
            },
          ]),
        ],
      );
      expect(n.rows[0]?.n).toBe(1);
      expect((await x.pool.query("select pinned from snippets")).rows[0]).toEqual({
        pinned: false,
      });
    } finally {
      await x.drop();
    }
  });
  it("every table in the schema is either in the backup or on the named exclusion list", async () => {
    const { rows } = await t.pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );
    const EXCLUDED = [
      "app_users",
      "gmail_connections",
      "lead_tokens",
      "reminders_sent",
      "job_runs",
      "schema_migrations",
      "stages",
      // Shop-level and system tables added for Selective CRM (0290–0430). The JSON file stays the merchant-level
      // export one person can keep; the shop's full state is the database backup (Supabase daily + pg_dump).
      "access_log",
      "user_alerts", // 0500: the alert feed, system state
      "ai_runs",
      "app_state_tz",
      "area_code_tz",
      "bucket_steps",
      "buckets",
      "commission_ledger",
      "commission_plans",
      "deals",
      "decline_reasons",
      "document_links",
      "document_views",
      "documents",
      "enrollments",
      "goals",
      "inbound_emails",
      "mail_sync_state",
      "mailboxes",
      "outbox",
      "proposed_updates",
      "send_ledger",
      "sheet_rows",
      "sheet_sources",
      "shop_registrations",
      "shop_settings",
      "state_rules",
      "suppressions",
      "template_variants",
      "templates",
      "upload_sessions",
      "webhook_events",
      "winback_members",
      "winback_pools",
      "commission_closes", // stream 3
      "commission_statements", // stream 3
      "fundings_corrections", // stream 3
      "winback_reasons", // stream 3
      "rescue_nudges", // stream 3
      "backdoor_reports", // stream 3
    ];
    const uncovered = rows
      .map((r) => r.table_name)
      .filter((n) => !BACKUP_TABLES.includes(n) && !EXCLUDED.includes(n));
    expect(uncovered).toEqual([]);
  });
});

describe("C-7: a stale tab can't delete a trashed merchant's advance, submission or offer", () => {
  it("direct deletes are refused; purge still removes everything", async () => {
    const { id, subs, offers } = await acceptedDeal();
    await asA((q) => q.query("select trash_client($1)", [id]));
    await expect(
      asA((q) => q.query("delete from offers where id = $1", [offers[1]])),
    ).rejects.toThrow(/in the trash/);
    await expect(asA((q) => q.query("select remove_offer($1)", [offers[1]]))).rejects.toThrow(
      /in the trash/,
    );
    await expect(
      asA((q) => q.query("delete from submissions where id = $1", [subs[1]])),
    ).rejects.toThrow(/in the trash/);
    expect((await t.pool.query("select 1 from offers where client_id = $1", [id])).rowCount).toBe(
      2,
    );
    await asA((q) => q.query("select purge_client($1)", [id]));
    expect((await t.pool.query("select 1 from offers where client_id = $1", [id])).rowCount).toBe(
      0,
    );
  });
});

const FORM: FundingForm = {
  fundedOn: "2026-10-23",
  amount: "50000",
  factorRate: "1.3",
  payment: "400",
  frequency: "daily",
  funderName: "Alpha",
  positionNo: "1",
  termDays: "",
  commission: "",
};
describe("C-8: the Funded dialog and the table refuse what Update funding would refuse", () => {
  it("position above 20, commission above the advance, a payoff over five years", () => {
    expect(checkFunding({ ...FORM, positionNo: "25" }, "2026-10-23").errors.positionNo).toMatch(
      /1 to 20/,
    );
    expect(
      checkFunding({ ...FORM, commission: "$60,000" }, "2026-10-23").errors.commission,
    ).toMatch(/more than the advance/);
    expect(checkFunding({ ...FORM, payment: "10" }, "2026-10-23").errors.payment).toMatch(
      /more than 5 years/,
    );
    expect(checkFunding(FORM, "2026-10-23").errors).toEqual({});
  });
  it("the table says no, in words, to the same things", async () => {
    const id = await merchant("Range check", "funded");
    const f = (over: Record<string, unknown>) =>
      asA((q) =>
        q.query("select * from record_funding($1, $2::jsonb, $3::jsonb)", [
          id,
          JSON.stringify({
            funded_on: d(-5),
            funder_name: "A",
            amount_cents: 5_000_000,
            factor_rate: 1.3,
            payment_cents: 50_000,
            frequency: "daily",
            position_no: 1,
            ...over,
          }),
          timersJson({ kind: "check_in", due_on: d(20) }),
        ]),
      );
    const msg = async (over: Record<string, unknown>) => {
      try {
        await f(over);
        return null;
      } catch (e) {
        return toActionError(e);
      }
    };
    expect(await msg({ position_no: 25 })).toBe("Position must be a whole number from 1 to 20");
    expect(await msg({ commission_cents: 6_000_000 })).toBe(
      "Commission can't be more than the advance",
    );
  });
});

describe("C-9: files the app downloads are kept out of git", () => {
  it(".gitignore names the backup and the CSV exports", () => {
    const ig = readFileSync(".gitignore", "utf8").split("\n");
    for (const p of [
      "isaac-backup-*.json",
      "isaac-clients-*.csv",
      "isaac-activity-*.csv",
      "isaac-notes-*.csv",
    ])
      expect(ig, p).toContain(p);
  });
});

describe("C-10: Update funding reads the commission box like the Funded dialog", () => {
  const TODAY = "2026-10-23";
  const withCommission = (c: string) =>
    checkTerms({ ...termsForm(funding({ commission_cents: null }), "UTC"), commission: c }, TODAY);
  it("a bare 6 is a question, 6,5 is a typo, 3,500 and $3k are fine", () => {
    expect(withCommission("6").errors.commission).toMatch(/points or dollars/);
    expect(withCommission("6,5").errors.commission).toBeDefined();
    expect(withCommission("3,500").commissionCents).toBe(350_000);
    expect(withCommission("$3k").commissionCents).toBe(300_000);
    expect(parseCommissionText("6,5", 5_000_000).ok).toBe(false);
  });
});

describe("C-11: defaults follow the user's day", () => {
  it("a competing offer typed without a date is dated today on his calendar", async () => {
    const utc = (
      await t.pool.query<{ d: string }>("select (now() at time zone 'UTC')::date::text d")
    ).rows[0]?.d;
    let tz = "Pacific/Kiritimati";
    let local = (
      await t.pool.query<{ d: string }>("select (now() at time zone $1)::date::text d", [tz])
    ).rows[0]?.d;
    if (local === utc) {
      tz = "Pacific/Pago_Pago";
      local = (
        await t.pool.query<{ d: string }>("select (now() at time zone $1)::date::text d", [tz])
      ).rows[0]?.d;
    }
    const u = await insertUser(t.pool, `far-${seq}@x.com`, tz);
    const id = await insertClient(t.db, u, "Far competing");
    await t.db.withUser(u, (q) =>
      q.query(
        "insert into competing_offers (user_id, client_id, funder_name) values (app.current_user_id(), $1, 'Rival')",
        [id],
      ),
    );
    expect(
      (
        await t.pool.query("select offered_on::text d from competing_offers where client_id = $1", [
          id,
        ])
      ).rows[0]?.d,
    ).toBe(local);
  });
});

describe("C-12: a date that is not on the calendar is refused before the database", () => {
  it("2026-02-30 and 2026-13-01", () => {
    const base = { fundingId: "11111111-1111-4111-8111-111111111111" };
    expect(termsUpdateSchema.safeParse({ ...base, fundedOn: "2026-02-30" }).success).toBe(false);
    expect(termsUpdateSchema.safeParse({ ...base, fundedOn: "2026-13-01" }).success).toBe(false);
    expect(termsUpdateSchema.safeParse({ ...base, fundedOn: "2026-02-28" }).success).toBe(true);
  });
});

describe("C-14: a do-not-contact merchant is listed but never marked hot", () => {
  it("both are on the list; only the one he may call is hot", () => {
    const base = {
      stage: "paid_in_full",
      stage_changed_at: "2026-10-20T12:00:00Z",
      last_touch_at: null,
      contact_status: "ok",
    };
    const r = buildRadar({
      cards: [
        { ...base, id: "ok1", business_name: "OK Co" },
        { ...base, id: "dnc1", business_name: "DNC Co", contact_status: "dnc" },
      ] as unknown as ClientCard[],
      advances: [],
      today: "2026-10-23",
      timezone: "UTC",
      minPct: null,
      thresholds: new Map(),
      commission: { average: null },
    });
    expect(r.paidInFull.map((p) => [p.card.business_name, p.hot]).sort()).toEqual([
      ["DNC Co", false],
      ["OK Co", true],
    ]);
  });
});

describe("C-8 follow-up: which problems stop a save of the Funding dialog", () => {
  const TODAY = "2026-10-23";
  it("an old advance's out-of-range box does not stop an unrelated edit", () => {
    const before = termsForm(funding({ position_no: 25 }), "UTC");
    const now = { ...before, note: "called the funder" };
    const errors = checkTerms(now, TODAY).errors;
    expect(errors.positionNo).toBeDefined();
    expect(blockingErrors(errors, now, before)).toEqual([]);
  });
  it("but a box he touched, or one checked against a box he touched, does", () => {
    const before = termsForm(funding(), "UTC");
    const bad = { ...before, positionNo: "25" };
    expect(blockingErrors(checkTerms(bad, TODAY).errors, bad, before)).toEqual(["positionNo"]);
    // an amount received with no day it arrived: the problem is on the day box, which he did not touch
    const half = { ...before, commissionReceived: "2,500" };
    const errors = checkTerms(half, TODAY).errors;
    expect(errors.commissionReceivedOn).toBeDefined();
    expect(blockingErrors(errors, half, before)).toContain("commissionReceivedOn");
  });
});
