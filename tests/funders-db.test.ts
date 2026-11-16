import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addBusinessDays, addDays, parseISODate } from "@/lib/mca/dates";
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
async function funder(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const cols = ["user_id", "name", ...Object.keys(extra)];
  const vals = [a, name, ...Object.values(extra)];
  const { rows } = await t.pool.query<{ id: string }>(
    `insert into funders (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    vals,
  );
  return rows[0]?.id as string;
}

/** A merchant in the given stage with one follow-up timer, the way the app leaves them. */
async function merchant(name: string, stage = "application_in"): Promise<string> {
  seq += 1;
  const id = await insertClient(t.db, a, `${name} ${seq}`);
  // each merchant is its own owner: the helper's one placeholder phone would make them all the same person to
  // the double-submission guard (0512), which matches by phone or email across every rep
  await t.pool.query("update clients set phone = $2 where id = $1", [
    id,
    `555${String(1000000 + seq).slice(-7)}`,
  ]);
  if (stage !== "name_in") {
    await asA((q) =>
      q.query("select * from move_client($1, $2, $3::jsonb)", [
        id,
        stage,
        timersJson({ kind: "follow_up", due_on: d(2) }),
      ]),
    );
  }
  return id;
}

const send = (clientId: string, funderIds: string[], sentOn: string | null = null, note = "") =>
  asA((q) =>
    q.query<{ id: string }>("select * from create_submissions($1, $2::uuid[], $3::date, $4)", [
      clientId,
      funderIds,
      sentOn,
      note,
    ]),
  );
const setStatus = (id: string, status: string, reason: string | null = null, note = "") =>
  asA((q) =>
    q.query("select * from set_submission_status($1, $2, $3, $4)", [id, status, reason, note]),
  );

const stageOf = async (id: string) =>
  (await t.pool.query<{ stage: string }>("select stage from clients where id = $1", [id])).rows[0]
    ?.stage;
const openTimers = async (id: string) =>
  (
    await t.pool.query<{
      kind: string;
      due_on: string;
      note: string;
      submission_id: string | null;
    }>(
      "select kind, due_on, note, submission_id from timers where client_id = $1 and done_at is null order by due_on, kind, note",
      [id],
    )
  ).rows;
const chaseFor = async (submissionId: string) =>
  (
    await t.pool.query<{ due_on: string; done_at: string | null; done_reason: string | null }>(
      "select due_on, done_at, done_reason from timers where submission_id = $1 order by created_at",
      [submissionId],
    )
  ).rows;
const bodies = async (id: string) =>
  (
    await t.pool.query<{ body: string; kind: string }>(
      "select body, kind from activities where client_id = $1 order by created_at, id",
      [id],
    )
  ).rows.map((r) => r.body);
const submissionRow = async (id: string) =>
  (
    await t.pool.query<{
      status: string;
      decline_reason: string | null;
      decline_note: string;
      note: string;
      responded_at: string | null;
    }>(
      "select status, decline_reason, decline_note, note, responded_at from submissions where id = $1",
      [id],
    )
  ).rows[0];

/** The most recent date (including today) that falls on the given weekday (0 = Sunday … 6 = Saturday). */
function lastWeekday(dow: number): string {
  let day = t.today;
  while (parseISODate(day).getUTCDay() !== dow) day = addDays(day, -1);
  return day;
}

describe("app.add_business_days", () => {
  it("matches addBusinessDays in TypeScript for every start date and span", async () => {
    const { rows } = await t.pool.query<{ from: string; n: number; got: string }>(
      `select s::date::text as "from", n, app.add_business_days(s::date, n)::text as got
         from generate_series(current_date - 20, current_date + 20, interval '1 day') s, generate_series(0, 7) n`,
    );
    expect(rows.length).toBe(41 * 8);
    for (const r of rows) expect(r.got).toBe(addBusinessDays(r.from, r.n));
  });
});

describe("timeline wording helpers", () => {
  it("format money and factor rates the way the app does", async () => {
    const { rows } = await t.pool.query(
      `select app.fmt_money(4500000) as a, app.fmt_money(45050) as b, app.fmt_money(99) as c,
              app.fmt_factor(1.34) as f1, app.fmt_factor(1.4) as f2, app.fmt_factor(1.345) as f3, app.fmt_factor(2) as f4`,
    );
    expect(rows[0]).toEqual({
      a: "$45,000",
      b: "$450.50",
      c: "$0.99",
      f1: "1.34",
      f2: "1.40",
      f3: "1.345",
      f4: "2.00",
    });
  });
});

describe("create_submissions", () => {
  it("creates a submission and a chase timer per funder, logs the timeline entry, and moves Application in to Submitted", async () => {
    const id = await merchant("Create");
    const pearl = await funder(`Pearl ${seq}`);
    const libertas = await funder(`Libertas ${seq}`);
    const { rows } = await send(id, [pearl, libertas], null, "full package");
    expect(rows.length).toBe(2);

    const subs = (
      await t.pool.query<{ funder_id: string; status: string; sent_on: string; note: string }>(
        "select funder_id, status, sent_on::text, note from submissions where client_id = $1 order by funder_id",
        [id],
      )
    ).rows;
    expect(subs.map((s) => s.funder_id).sort()).toEqual([pearl, libertas].sort());
    expect(subs.every((s) => s.status === "sent" && s.sent_on === t.today)).toBe(true);
    expect(subs.every((s) => s.note === "full package")).toBe(true);

    expect(await stageOf(id)).toBe("submitted");
    const open = await openTimers(id);
    const chase = open.filter((x) => x.kind === "chase");
    expect(chase.length).toBe(2);
    expect(chase.every((x) => x.due_on === addBusinessDays(t.today, 1))).toBe(true);
    expect(new Set(chase.map((x) => x.submission_id)).size).toBe(2);
    // the stage move's own follow-up is there too, so the merchant is never left without a date
    expect(open.filter((x) => x.kind === "follow_up").length).toBe(1);

    const log = await bodies(id);
    expect(log).toContain(`Submitted to Libertas ${seq}, Pearl ${seq} — full package`);
    const move = await t.pool.query(
      "select from_stage, to_stage from activities where client_id = $1 and kind = 'stage_change' order by created_at desc limit 1",
      [id],
    );
    expect(move.rows[0]).toEqual({ from_stage: "application_in", to_stage: "submitted" });
  });

  it("moves Collecting stips to Submitted, and leaves every other stage where it is", async () => {
    const f = await funder(`Stage Fund ${seq}`);
    const stips = await merchant("Stips", "stips");
    await send(stips, [f]);
    expect(await stageOf(stips)).toBe("submitted");

    for (const stage of ["interested", "offers_in", "offer_presented", "submitted"]) {
      const id = await merchant(`Stay ${stage}`, stage);
      await send(id, [f]);
      expect(await stageOf(id)).toBe(stage);
      expect((await openTimers(id)).some((x) => x.kind === "chase")).toBe(true);
    }
  });

  it("due date skips the weekend: Friday and Saturday sends are chased on Monday, Sunday on Monday", async () => {
    const f = await funder(`Weekend Fund ${seq}`);
    const friday = lastWeekday(5);
    const saturday = lastWeekday(6);
    const sunday = lastWeekday(0);
    for (const day of [friday, saturday, sunday]) {
      const id = await merchant("Weekend");
      const { rows } = await send(id, [f], day);
      const chase = await chaseFor(rows[0]?.id as string);
      expect(chase).toHaveLength(1);
      expect(chase[0]?.due_on).toBe(addBusinessDays(day, 1));
      expect(parseISODate(chase[0]?.due_on as string).getUTCDay()).toBe(1);
    }
  });

  it("a back-dated send is chased from the day it was really sent", async () => {
    const f = await funder(`Backdate Fund ${seq}`);
    const id = await merchant("Backdate");
    const sent = addDays(t.today, -5);
    const { rows } = await send(id, [f], sent);
    expect((await chaseFor(rows[0]?.id as string))[0]?.due_on).toBe(addBusinessDays(sent, 1));
  });

  it("refuses the same funder twice on the same day, creates nothing, and allows a later re-submission", async () => {
    const id = await merchant("Dup");
    const pearl = await funder(`Dup Pearl ${seq}`);
    const other = await funder(`Dup Other ${seq}`);
    await send(id, [pearl]);
    await expect(send(id, [other, pearl])).rejects.toThrow(/Already sent to Dup Pearl/);
    const n = await t.pool.query(
      "select count(*)::int as n from submissions where client_id = $1",
      [id],
    );
    expect(n.rows[0].n).toBe(1);
    // another day inside the shop's window is a double submission (0512): refused, naming the lender and the date
    await expect(send(id, [pearl], addDays(t.today, -3))).rejects.toThrow(
      new RegExp(`already went to Dup Pearl ${seq} on \\w{3} \\d{1,2}.*waits 30 days`),
    );
    // past the window it is a re-submission, which is allowed
    await t.pool.query("update shop_settings set resubmit_block_days = 2");
    await send(id, [pearl], addDays(t.today, -3));
    await t.pool.query("update shop_settings set resubmit_block_days = 30");
    const after = await t.pool.query(
      "select count(*)::int as n from submissions where client_id = $1",
      [id],
    );
    expect(after.rows[0].n).toBe(2);
    // and the unique index backs the function up
    await expect(
      t.pool.query(
        "insert into submissions (user_id, client_id, funder_id, sent_on) values ($1, $2, $3, $4)",
        [a, id, pearl, t.today],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("refuses an empty list, an archived funder, a future date, a date over a year old and a repeated funder id", async () => {
    const id = await merchant("Refuse");
    const f = await funder(`Refuse Fund ${seq}`);
    const archived = await funder(`Archived Fund ${seq}`, { active: false });
    await expect(send(id, [])).rejects.toThrow(/pick at least one funder/);
    await expect(send(id, [archived])).rejects.toThrow(/is archived/);
    await expect(send(id, [f], addDays(t.today, 5))).rejects.toThrow(/in the future/);
    await expect(send(id, [f], addDays(t.today, -400))).rejects.toThrow(/more than a year ago/);
    const { rows } = await send(id, [f, f]);
    expect(rows).toHaveLength(1);
  });

  it("keeps the chase on a funder that hasn't answered when a later send moves the stage", async () => {
    const id = await merchant("Keep", "stips");
    const x = await funder(`Keep X ${seq}`);
    const y = await funder(`Keep Y ${seq}`);
    const sx = (await send(id, [x])).rows[0]?.id as string;
    expect(await stageOf(id)).toBe("submitted");
    const original = (await chaseFor(sx))[0];
    // the merchant goes back to Collecting stips (set directly, so X's chase is still open)
    await t.pool.query("update clients set stage = 'stips' where id = $1", [id]);
    await send(id, [y]);
    expect(await stageOf(id)).toBe("submitted");
    const rows = await chaseFor(sx);
    // the move left X's chase alone: the same single row, still open, same due date
    expect(rows.map((r) => r.done_reason)).toEqual([null]);
    expect(rows[0]?.due_on).toBe(original?.due_on);
    expect((await openTimers(id)).filter((r) => r.kind === "chase")).toHaveLength(2);
  });
});

describe("the chase timer", () => {
  it("is not closed by logging a call, text or email to the merchant", async () => {
    const id = await merchant("Chase Touch");
    const f = await funder(`Touch Fund ${seq}`);
    const sub = (await send(id, [f])).rows[0]?.id as string;
    for (const kind of ["call", "text", "email"]) {
      await asA((q) =>
        q.query("select * from log_touch($1, $2, 'reached', 'spoke', $3)", [id, kind, d(7)]),
      );
    }
    const chase = await chaseFor(sub);
    expect(chase).toHaveLength(1);
    expect(chase[0]?.done_at).toBeNull();
    // and the client's next date is still the chase, because it is the earliest open timer
    const card = await t.pool.query(
      "select next_due_on::text as due, next_due_kind from client_cards where id = $1",
      [id],
    );
    expect(card.rows[0]).toEqual({
      due: addBusinessDays(t.today, 1),
      next_due_kind: expect.stringMatching(/^(chase|follow_up)$/),
    });
  });

  it("counts toward the client's next due date", async () => {
    const id = await merchant("Chase Due", "interested");
    await t.pool.query("update timers set due_on = $2 where client_id = $1 and done_at is null", [
      id,
      d(30),
    ]);
    const f = await funder(`Due Fund ${seq}`);
    await send(id, [f]);
    const card = await t.pool.query(
      "select next_due_on::text as due, next_due_kind from client_cards where id = $1",
      [id],
    );
    expect(card.rows[0]).toEqual({ due: addBusinessDays(t.today, 1), next_due_kind: "chase" });
  });

  it.each(["approved", "declined", "stips_requested", "no_response", "withdrawn"])(
    "is closed as completed when the submission becomes %s",
    async (status) => {
      const id = await merchant(`Closes ${status}`);
      const f = await funder(`Closes Fund ${status} ${seq}`);
      const sub = (await send(id, [f])).rows[0]?.id as string;
      await setStatus(sub, status, status === "declined" ? "other" : null);
      const chase = await chaseFor(sub);
      expect(chase).toHaveLength(1);
      expect(chase[0]?.done_reason).toBe("completed");
      expect(chase[0]?.done_at).not.toBeNull();
    },
  );

  it("one funder answering closes only that funder's chase", async () => {
    const id = await merchant("Chase Only One");
    const f1 = await funder(`One A ${seq}`);
    const f2 = await funder(`One B ${seq}`);
    const rows = (await send(id, [f1, f2])).rows;
    await setStatus(rows[0]?.id as string, "declined", "credit");
    expect((await openTimers(id)).filter((x) => x.kind === "chase")).toHaveLength(1);
    expect((await chaseFor(rows[1]?.id as string))[0]?.done_at).toBeNull();
  });

  it("a funder's yes moves the deal to Offers in without dropping the chase on the funders still silent", async () => {
    const id = await merchant("Chase Survives Move");
    const f1 = await funder(`Move A ${seq}`);
    const f2 = await funder(`Move B ${seq}`);
    const f3 = await funder(`Move C ${seq}`);
    const rows = (await send(id, [f1, f2, f3])).rows;
    const before = await openTimers(id);
    await setStatus(rows[0]?.id as string, "approved");
    expect(await stageOf(id)).toBe("offers_in");
    const after = (await openTimers(id)).filter((x) => x.kind === "chase");
    expect(after).toHaveLength(2);
    expect(after.map((x) => x.submission_id).sort()).toEqual([rows[1]?.id, rows[2]?.id].sort());
    expect(after.map((x) => x.due_on)).toEqual(
      before
        .filter((x) => x.kind === "chase" && x.submission_id !== rows[0]?.id)
        .map((x) => x.due_on),
    );
  });

  it("re-opening an answered submission waits for the funder again with a fresh chase", async () => {
    const id = await merchant("Reopen");
    const f = await funder(`Reopen Fund ${seq}`);
    const sub = (await send(id, [f])).rows[0]?.id as string;
    await setStatus(sub, "declined", "revenue", "too thin");
    expect((await submissionRow(sub))?.responded_at).not.toBeNull();
    await setStatus(sub, "sent");
    const row = await submissionRow(sub);
    // a mistaken decline that is undone must not count as an answer
    expect(row?.status).toBe("sent");
    expect(row?.decline_reason).toBeNull();
    expect(row?.decline_note).toBe("");
    expect(row?.responded_at).toBeNull();
    const chase = await chaseFor(sub);
    expect(chase.map((c) => c.done_reason)).toEqual(["completed", null]);
    expect(chase[1]?.due_on).toBe(addBusinessDays(t.today, 1));
    // pressing it again does not stack a second open chase
    await setStatus(sub, "sent");
    expect((await chaseFor(sub)).filter((c) => c.done_at === null)).toHaveLength(1);
  });

  it("is closed ('stage_moved') when the merchant is moved by hand, and the card falls back to the stage timer", async () => {
    const id = await merchant("Hand Move");
    const f = await funder(`Hand Fund ${seq}`);
    const sub = (await send(id, [f])).rows[0]?.id as string;
    await asA((q) =>
      q.query("select * from move_client($1, 'dead', $2::jsonb)", [
        id,
        timersJson({ kind: "follow_up", due_on: d(270) }),
      ]),
    );
    expect((await chaseFor(sub))[0]?.done_reason).toBe("stage_moved");
    expect((await openTimers(id)).map((x) => x.kind)).toEqual(["follow_up"]);
  });

  it("the table refuses a chase timer without a submission and a submission on any other kind", async () => {
    const id = await merchant("Shape");
    await expect(
      t.pool.query(
        "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'chase', current_date)",
        [a, id],
      ),
    ).rejects.toThrow(/timers_chase_has_submission/);
    const f = await funder(`Shape Fund ${seq}`);
    const sub = (await send(id, [f])).rows[0]?.id as string;
    await expect(
      t.pool.query(
        "insert into timers (user_id, client_id, kind, due_on, submission_id) values ($1, $2, 'follow_up', current_date, $3)",
        [a, id, sub],
      ),
    ).rejects.toThrow(/timers_chase_has_submission/);
    await expect(
      t.pool.query(
        "insert into timers (user_id, client_id, kind, due_on, submission_id) values ($1, $2, 'chase', current_date, $3)",
        [a, id, sub],
      ),
    ).rejects.toThrow(/timers_one_open_chase_idx/);
    await expect(
      t.pool.query(
        "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'bogus', current_date)",
        [a, id],
      ),
    ).rejects.toThrow(/timers_kind_check/);
  });
});

describe("set_submission_status", () => {
  it("records a decline with its reason and note, stamps the answer, and changes no stage", async () => {
    const id = await merchant("Decline");
    const f = await funder(`Decline Fund ${seq}`);
    const sub = (await send(id, [f], null, "sent note")).rows[0]?.id as string;
    await setStatus(sub, "declined", "over_leveraged", "four positions already");
    const row = await submissionRow(sub);
    expect(row).toMatchObject({
      status: "declined",
      decline_reason: "over_leveraged",
      decline_note: "four positions already",
      note: "sent note",
    });
    expect(row?.responded_at).not.toBeNull();
    expect(await stageOf(id)).toBe("submitted");
    expect((await bodies(id)).at(-1)).toBe(
      `Decline Fund ${seq} declined — over-leveraged — four positions already`,
    );
  });

  it("refuses a reason on anything but a decline, an unknown reason and an unknown status", async () => {
    const id = await merchant("Bad Args");
    const f = await funder(`Bad Fund ${seq}`);
    const sub = (await send(id, [f])).rows[0]?.id as string;
    await expect(setStatus(sub, "approved", "credit")).rejects.toThrow(
      /decline reason only goes with a decline/,
    );
    await expect(setStatus(sub, "declined", "mood")).rejects.toThrow(/unknown decline reason/);
    await expect(setStatus(sub, "maybe")).rejects.toThrow(/unknown submission status/);
    expect((await submissionRow(sub))?.status).toBe("sent");
    expect((await chaseFor(sub))[0]?.done_at).toBeNull();
  });

  it("stips requested sets a near follow-up to go get them, unless one is already due that soon", async () => {
    const id = await merchant("Stips Ask");
    const fname = `Stips Fund ${seq}`;
    const f = await funder(fname);
    const sub = (await send(id, [f])).rows[0]?.id as string;
    // the stage move left a follow-up 1 business day out, which already covers it
    await setStatus(sub, "stips_requested", null, "3 months of statements");
    expect((await openTimers(id)).filter((x) => x.kind === "follow_up")).toHaveLength(1);
    expect((await submissionRow(sub))?.note).toBe("3 months of statements");

    const id2 = await merchant("Stips Ask Far", "interested");
    await t.pool.query("update timers set due_on = $2 where client_id = $1 and done_at is null", [
      id2,
      d(20),
    ]);
    const sub2 = (await send(id2, [f])).rows[0]?.id as string;
    await setStatus(sub2, "stips_requested", null, "voided check");
    const follow = (await openTimers(id2)).filter((x) => x.kind === "follow_up");
    expect(follow.map((x) => x.due_on).sort()).toEqual([addBusinessDays(t.today, 1), d(20)].sort());
    expect(follow.find((x) => x.due_on === addBusinessDays(t.today, 1))?.note).toBe(
      `Get stips for ${fname}: voided check`,
    );
  });

  it("approved brings an earlier deal to Offers in, but never drags a later one back", async () => {
    const f = await funder(`Promote Fund ${seq}`);
    for (const [stage, expected] of [
      ["submitted", "offers_in"],
      ["stips", "offers_in"],
      ["interested", "offers_in"],
      ["declined", "offers_in"],
      ["offer_presented", "offer_presented"],
      ["contract_out", "contract_out"],
      ["funded", "funded"],
      ["not_interested", "not_interested"],
    ] as const) {
      const id = await merchant(`Promote ${stage}`, stage === "funded" ? "name_in" : stage);
      if (stage === "funded")
        await asA((q) =>
          q.query("select * from move_client($1, 'funded', $2::jsonb)", [
            id,
            timersJson({ kind: "check_in", due_on: d(30) }),
          ]),
        );
      const sub = (await send(id, [f])).rows[0]?.id as string;
      await setStatus(sub, "approved");
      expect(await stageOf(id), stage).toBe(expected);
    }
  });

  it("declined or withdrawn takes that funder's open offers with it, but not an accepted one", async () => {
    const id = await merchant("Offers Lapse");
    const f = await funder(`Lapse Fund ${seq}`);
    const sub = (await send(id, [f])).rows[0]?.id as string;
    const o = (type: number) =>
      asA(
        async (q) =>
          (
            await q.query<{ id: string }>("select * from record_offer($1, $2::jsonb)", [
              sub,
              JSON.stringify({ amount_cents: 4_000_000 + type, factor_rate: 1.3 }),
            ])
          ).rows[0]?.id as string,
      );
    const o2 = await o(2);
    await asA((q) => q.query("select * from accept_offer($1)", [o2]));
    const o1 = await o(1); // a second offer after the first was taken: still open
    await setStatus(sub, "withdrawn");
    const rows = (
      await t.pool.query<{ id: string; status: string }>(
        "select id, status from offers where submission_id = $1",
        [sub],
      )
    ).rows;
    expect(rows.find((r) => r.id === o1)?.status).toBe("expired");
    expect(rows.find((r) => r.id === o2)?.status).toBe("accepted");
  });

  it("never leaves the client with no next date, even when the chase was the only timer", async () => {
    const id = await merchant("Only Chase");
    const f = await funder(`Only Fund ${seq}`);
    const sub = (await send(id, [f])).rows[0]?.id as string;
    await t.pool.query(
      "update timers set done_at = now(), done_reason = 'cancelled' where client_id = $1 and kind = 'follow_up' and done_at is null",
      [id],
    );
    expect((await openTimers(id)).map((x) => x.kind)).toEqual(["chase"]);
    await setStatus(sub, "declined", "credit");
    const open = await openTimers(id);
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("follow_up");
    expect(open[0]?.due_on).toBe(addBusinessDays(t.today, 1));
  });

  it("is a 'not found' for an id that does not exist", async () => {
    await expect(setStatus("00000000-0000-4000-8000-000000000000", "approved")).rejects.toThrow(
      /submission not found/,
    );
  });
});

describe("record_offer", () => {
  const offer = (sub: string, extra: Record<string, unknown> = {}) =>
    asA((q) =>
      q.query<{ id: string }>("select * from record_offer($1, $2::jsonb)", [
        sub,
        JSON.stringify({
          amount_cents: 4_500_000,
          factor_rate: 1.34,
          payment_cents: 45_000,
          frequency: "daily",
          term_days: 130,
          position_no: 2,
          fees_cents: 50_000,
          note: "verbal",
          ...extra,
        }),
      ]),
    );

  it("stores the offer, marks the submission approved, closes its chase and brings the deal to Offers in", async () => {
    const id = await merchant("Offer In");
    const f = await funder(`Offer Fund ${seq}`);
    const other = await funder(`Offer Other ${seq}`);
    const [first, second] = (await send(id, [f, other])).rows;
    const res = await offer(first?.id as string);
    const stored = await t.pool.query(
      `select amount_cents, factor_rate::float8 as factor_rate, payment_cents, frequency, term_days, position_no,
              fees_cents, note, status, received_on::text as received_on, client_id, submission_id
         from offers where id = $1`,
      [res.rows[0]?.id],
    );
    expect(stored.rows[0]).toEqual({
      amount_cents: 4_500_000,
      factor_rate: 1.34,
      payment_cents: 45_000,
      frequency: "daily",
      term_days: 130,
      position_no: 2,
      fees_cents: 50_000,
      note: "verbal",
      status: "open",
      received_on: t.today,
      client_id: id,
      submission_id: first?.id,
    });
    const sub = await submissionRow(first?.id as string);
    expect(sub?.status).toBe("approved");
    expect(sub?.responded_at).not.toBeNull();
    expect((await chaseFor(first?.id as string))[0]?.done_reason).toBe("completed");
    expect(await stageOf(id)).toBe("offers_in");
    // the funder that hasn't answered keeps its chase
    expect((await chaseFor(second?.id as string)).filter((c) => c.done_at === null)).toHaveLength(
      1,
    );
    const log = await bodies(id);
    expect(log).toContain(`Offer Fund ${seq} approved: $45,000 at 1.34 factor, $450 daily`);
    expect(log.at(-1)).toBe(`Offer from Offer Fund ${seq}`); // the stage move's reason
  });

  it("takes only an amount and a factor, and lets a funder make more than one offer", async () => {
    const id = await merchant("Offer Minimal");
    const f = await funder(`Minimal Fund ${seq}`);
    const sub = (await send(id, [f])).rows[0]?.id as string;
    await offer(sub, {
      payment_cents: null,
      frequency: null,
      term_days: null,
      position_no: null,
      fees_cents: null,
      note: "",
    });
    await offer(sub, { amount_cents: 3_000_000, factor_rate: 1.4 });
    const n = await t.pool.query("select count(*)::int as n from offers where submission_id = $1", [
      sub,
    ]);
    expect(n.rows[0].n).toBe(2);
  });

  it("rejects values the table does not allow, and changes nothing", async () => {
    const id = await merchant("Offer Bad");
    const f = await funder(`Bad Offer Fund ${seq}`);
    const sub = (await send(id, [f])).rows[0]?.id as string;
    await expect(offer(sub, { factor_rate: 0.9 })).rejects.toThrow(/offers_factor_rate_check/);
    await expect(offer(sub, { amount_cents: 0 })).rejects.toThrow(/offers_amount_cents_check/);
    await expect(offer(sub, { frequency: "hourly" })).rejects.toThrow(/offers_frequency_check/);
    await expect(offer(sub, { received_on: addDays(t.today, 9) })).rejects.toThrow(/in the future/);
    expect((await submissionRow(sub))?.status).toBe("sent");
    expect((await chaseFor(sub))[0]?.done_at).toBeNull();
    const n = await t.pool.query("select count(*)::int as n from offers where submission_id = $1", [
      sub,
    ]);
    expect(n.rows[0].n).toBe(0);
  });

  it("a funder that declined and then came back with an offer is approved again", async () => {
    const id = await merchant("Offer Comeback");
    const f = await funder(`Comeback Fund ${seq}`);
    const sub = (await send(id, [f])).rows[0]?.id as string;
    await setStatus(sub, "declined", "revenue", "too thin");
    await offer(sub);
    expect(await submissionRow(sub)).toMatchObject({
      status: "approved",
      decline_reason: null,
      decline_note: "",
    });
  });
});

describe("accept_offer", () => {
  async function twoOffers() {
    const id = await merchant("Accept");
    const f1 = await funder(`Accept A ${seq}`);
    const f2 = await funder(`Accept B ${seq}`);
    const [s1, s2] = (await send(id, [f1, f2])).rows;
    const mk = async (sub: string, factor: number, amount: number) =>
      (
        await asA((q) =>
          q.query<{ id: string }>("select * from record_offer($1, $2::jsonb)", [
            sub,
            JSON.stringify({
              amount_cents: amount,
              factor_rate: factor,
              payment_cents: 40_000,
              frequency: "daily",
            }),
          ]),
        )
      ).rows[0]?.id as string;
    const o1 = await mk(s1?.id as string, 1.34, 4_500_000);
    const o2 = await mk(s2?.id as string, 1.31, 4_000_000);
    return { id, o1, o2 };
  }
  const statuses = async (ids: string[]) =>
    Object.fromEntries(
      (
        await t.pool.query<{ id: string; status: string }>(
          "select id, status from offers where id = any($1::uuid[])",
          [ids],
        )
      ).rows.map((r) => [r.id, r.status]),
    );

  it("accepts one, turns the merchant's other live offers down, and does NOT fund or move the stage", async () => {
    const { id, o1, o2 } = await twoOffers();
    await asA((q) => q.query("select * from set_offer_status($1, 'presented')", [o1]));
    await asA((q) => q.query("select * from accept_offer($1)", [o2]));
    expect(await statuses([o1, o2])).toEqual({ [o1]: "declined", [o2]: "accepted" });
    expect(await stageOf(id)).toBe("offers_in");
    const f = await t.pool.query("select count(*)::int as n from fundings where client_id = $1", [
      id,
    ]);
    expect(f.rows[0].n).toBe(0);
    expect((await bodies(id)).at(-1)).toBe(
      `Accepted Accept B ${seq}'s offer: $40,000 at 1.31 factor`,
    );
  });

  it("is idempotent, and changing his mind swaps which one is accepted", async () => {
    const { o1, o2 } = await twoOffers();
    await asA((q) => q.query("select * from accept_offer($1)", [o2]));
    await asA((q) => q.query("select * from accept_offer($1)", [o2]));
    expect(await statuses([o1, o2])).toEqual({ [o1]: "declined", [o2]: "accepted" });
    await asA((q) => q.query("select * from accept_offer($1)", [o1]));
    expect(await statuses([o1, o2])).toEqual({ [o1]: "accepted", [o2]: "declined" });
  });

  it("leaves offers on other merchants alone", async () => {
    const { o1 } = await twoOffers();
    const { o1: elsewhere } = await twoOffers();
    await asA((q) => q.query("select * from accept_offer($1)", [o1]));
    expect((await statuses([elsewhere]))[elsewhere]).toBe("open");
  });

  it("funding the accepted terms goes through record_funding and leaves the offer accepted", async () => {
    const { id, o2 } = await twoOffers();
    await asA((q) => q.query("select * from accept_offer($1)", [o2]));
    await asA((q) =>
      q.query("select * from record_funding($1, $2::jsonb, $3::jsonb)", [
        id,
        JSON.stringify({
          funded_on: t.today,
          funder_name: "Accept B",
          amount_cents: 4_000_000,
          factor_rate: 1.31,
          payment_cents: 40_000,
          frequency: "daily",
          position_no: 1,
        }),
        timersJson({ kind: "check_in", due_on: d(30) }),
      ]),
    );
    expect(await stageOf(id)).toBe("funded");
    expect((await statuses([o2]))[o2]).toBe("accepted");
  });
});

describe("set_offer_status and remove_submission", () => {
  it("moves an offer between present / reopen / turn down / expire, refuses accepted, and logs it", async () => {
    const id = await merchant("Offer Status");
    const f = await funder(`Status Fund ${seq}`);
    const sub = (await send(id, [f])).rows[0]?.id as string;
    const o = (
      await asA((q) =>
        q.query<{ id: string }>("select * from record_offer($1, $2::jsonb)", [
          sub,
          JSON.stringify({ amount_cents: 1_000_000, factor_rate: 1.4 }),
        ]),
      )
    ).rows[0]?.id as string;
    for (const s of ["presented", "declined", "expired", "open"]) {
      await asA((q) => q.query("select * from set_offer_status($1, $2)", [o, s]));
      const row = await t.pool.query("select status from offers where id = $1", [o]);
      expect(row.rows[0].status).toBe(s);
    }
    await expect(
      asA((q) => q.query("select * from set_offer_status($1, 'accepted')", [o])),
    ).rejects.toThrow(/unknown offer status/);
    expect((await bodies(id)).at(-1)).toBe(`Status Fund ${seq}'s offer reopened`);
  });

  it("removes a mistaken submission with its offers and chase, and keeps the merchant's next date", async () => {
    const id = await merchant("Remove");
    const f1 = await funder(`Remove A ${seq}`);
    const f2 = await funder(`Remove B ${seq}`);
    const [s1, s2] = (await send(id, [f1, f2])).rows;
    await asA((q) =>
      q.query("select * from record_offer($1, $2::jsonb)", [
        s1?.id,
        JSON.stringify({ amount_cents: 1_000_000, factor_rate: 1.4 }),
      ]),
    );
    await asA((q) => q.query("select remove_submission($1)", [s1?.id]));
    const left = await t.pool.query("select id from submissions where client_id = $1", [id]);
    expect(left.rows.map((r) => r.id)).toEqual([s2?.id]);
    const offers = await t.pool.query(
      "select count(*)::int as n from offers where client_id = $1",
      [id],
    );
    expect(offers.rows[0].n).toBe(0);
    expect(await chaseFor(s1?.id as string)).toEqual([]);
    expect((await openTimers(id)).length).toBeGreaterThan(0);
    expect((await bodies(id)).at(-1)).toBe(`Removed the submission to Remove A ${seq}`);
  });

  it("deleting the merchant cascades through submissions, offers and chase timers; the funder survives", async () => {
    const id = await merchant("Cascade");
    const f = await funder(`Cascade Fund ${seq}`);
    const sub = (await send(id, [f])).rows[0]?.id as string;
    await asA((q) =>
      q.query("select * from record_offer($1, $2::jsonb)", [
        sub,
        JSON.stringify({ amount_cents: 1_000_000, factor_rate: 1.4 }),
      ]),
    );
    await asA((q) => q.query("delete from clients where id = $1", [id]));
    for (const table of ["submissions", "offers"]) {
      const n = await t.pool.query(`select count(*)::int as n from ${table} where client_id = $1`, [
        id,
      ]);
      expect(n.rows[0].n).toBe(0);
    }
    expect((await chaseFor(sub)).length).toBe(0);
    expect((await t.pool.query("select 1 from funders where id = $1", [f])).rowCount).toBe(1);
  });

  it("deleting the whole user (the account) cascades through funders, merchants, submissions, offers and timers", async () => {
    const owner = await insertUser(t.pool, "leaving@x.com", "UTC");
    const client = await insertClient(t.db, owner, "Leaving Co");
    const f = await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name) values ($1, 'Leaving Fund') returning id",
      [owner],
    );
    const sub = await t.db.withUser(owner, (q) =>
      q.query<{ id: string }>("select * from create_submissions($1, $2::uuid[])", [
        client,
        [f.rows[0]?.id],
      ]),
    );
    await t.db.withUser(owner, (q) =>
      q.query("select * from record_offer($1, $2::jsonb)", [
        sub.rows[0]?.id,
        JSON.stringify({ amount_cents: 1_000_000, factor_rate: 1.4 }),
      ]),
    );
    await t.pool.query("delete from app_users where id = $1", [owner]);
    for (const table of ["funders", "submissions", "offers", "clients", "timers"]) {
      const n = await t.pool.query(`select count(*)::int as n from ${table} where user_id = $1`, [
        owner,
      ]);
      expect(n.rows[0].n, table).toBe(0);
    }
  });

  it("a funder with submissions cannot be deleted (archive it instead)", async () => {
    const id = await merchant("Restrict");
    const f = await funder(`Restrict Fund ${seq}`);
    await send(id, [f]);
    await expect(asA((q) => q.query("delete from funders where id = $1", [f]))).rejects.toThrow(
      /foreign key/,
    );
  });
});

describe("funders table", () => {
  it("keeps names unique across the shop ignoring case and spaces", async () => {
    await funder("Unique Capital");
    await expect(funder("  unique capital ")).rejects.toThrow(/funders_name_key/);
  });
  it("refuses an inverted advance range and out-of-range appetite values", async () => {
    await expect(
      funder("Range A", { min_amount_cents: 500, max_amount_cents: 100 }),
    ).rejects.toThrow(/check constraint/);
    await expect(funder("Range B", { max_position: 0 })).rejects.toThrow(/check constraint/);
    await expect(funder("Range C", { commission_points: 120 })).rejects.toThrow(/check constraint/);
    await expect(funder("Range D", { renewal_paydown_pct: 0 })).rejects.toThrow(/check constraint/);
    await expect(funder("   ")).rejects.toThrow(/check constraint/);
  });
  it("stores appetite lists and defaults", async () => {
    const f = await funder("Lists Capital", {
      excluded_states: ["FL", "NY"],
      excluded_industries: ["restaurants", "trucking"],
      commission_points: 7.5,
      renewal_paydown_pct: 60,
    });
    const row = await t.pool.query(
      "select active, excluded_states, excluded_industries, commission_points::float8 as pts, renewal_paydown_pct from funders where id = $1",
      [f],
    );
    expect(row.rows[0]).toEqual({
      active: true,
      excluded_states: ["FL", "NY"],
      excluded_industries: ["restaurants", "trucking"],
      pts: 7.5,
      renewal_paydown_pct: 60,
    });
  });
});
