import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertContactAllowed, logTouch, setContactStatus } from "@/lib/data/mutations";
import { contactStatusSchema } from "@/lib/data/schemas";
import { buildToday } from "@/lib/data/views";
import type { ClientCard } from "@/lib/data/types";
import { addDays, addMonths } from "@/lib/mca/dates";
import { contactAllowed, quietHours, stateTimezone } from "@/lib/mca/contact";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

describe("who may be contacted how", () => {
  it("a do-not-contact merchant allows nothing", () => {
    for (const kind of ["call", "text", "email"] as const) {
      expect(contactAllowed("dnc", kind)).toEqual({ ok: false, reason: "Marked do-not-contact" });
    }
  });
  it("a channel restriction blocks only that channel", () => {
    expect(contactAllowed("no_text", "text").ok).toBe(false);
    expect(contactAllowed("no_text", "call").ok).toBe(true);
    expect(contactAllowed("no_call", "call").ok).toBe(false);
    expect(contactAllowed("no_call", "email").ok).toBe(true);
    expect(contactAllowed("no_email", "email").ok).toBe(false);
    expect(contactAllowed("ok", "text").ok).toBe(true);
  });
});

describe("quiet hours by where the merchant is", () => {
  it.each([
    ["TX", "America/Chicago"],
    ["tx", "America/Chicago"],
    ["Texas", "America/Chicago"],
    ["New York", "America/New_York"],
    ["CA", "America/Los_Angeles"],
    ["Arizona", "America/Phoenix"],
    ["HI", "Pacific/Honolulu"],
  ])("%s → %s", (raw, tz) => {
    expect(stateTimezone(raw)).toBe(tz);
  });
  it("never guesses an unknown state", () => {
    expect(stateTimezone("")).toBeNull();
    expect(stateTimezone("Narnia")).toBeNull();
    expect(stateTimezone("ZZ")).toBeNull();
    expect(quietHours("Narnia", new Date("2026-10-23T03:00:00Z"))).toBeNull();
  });
  it("warns before 8 AM and from 9 PM in the MERCHANT'S time, not Isaac's", () => {
    // 02:00 UTC Oct 24 = 10 PM in Chicago, 7 PM in Los Angeles
    const night = new Date("2026-10-24T02:00:00Z");
    expect(quietHours("TX", night)?.localTime).toBe("9:00 PM");
    expect(quietHours("CA", night)).toBeNull();
    // 12:30 UTC = 7:30 AM Chicago, 5:30 AM Los Angeles, 8:30 AM New York
    const early = new Date("2026-10-23T12:30:00Z");
    expect(quietHours("TX", early)?.localTime).toBe("7:30 AM");
    expect(quietHours("NY", early)).toBeNull();
  });
  it("is fine through the working day, with 8:00 and 8:59 PM allowed", () => {
    expect(quietHours("TX", new Date("2026-10-23T13:00:00Z"))).toBeNull(); // 8:00 AM CDT
    expect(quietHours("TX", new Date("2026-10-24T01:59:00Z"))).toBeNull(); // 8:59 PM CDT
  });
});

let t: TestDb;
let a: string;
let b: string;
const d = (n: number) => addDays(t.today, n);
const ctx = () => ({ today: t.today, timezone: "UTC" });

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "UTC");
  b = await insertUser(t.pool, "other@x.com", "UTC");
});
afterAll(async () => {
  await t.drop();
});

const open = async (id: string) =>
  (
    await t.pool.query(
      "select kind, due_on::text, note from timers where client_id = $1 and done_at is null order by due_on",
      [id],
    )
  ).rows;

describe("set_contact_status in the database", () => {
  it("do-not-contact cancels every timer and booked call, leaving ONE review reminder 36 months out", async () => {
    const id = await insertClient(t.db, a, "Stop Co");
    await t.pool.query(
      "update clients set scheduled_call_at = now() + interval '5 hours' where id = $1",
      [id],
    );
    await t.pool.query(
      "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'scheduled_call', $3), ($1, $2, 'renewal', $4)",
      [a, id, d(0), d(60)],
    );
    await t.db.withUser(a, (q) =>
      setContactStatus(
        q,
        contactStatusSchema.parse({
          clientId: id,
          status: "dnc",
          note: "asked us to stop on the phone",
        }),
      ),
    );
    const timers = await open(id);
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({
      kind: "follow_up",
      note: "Do-not-contact — review this status",
    });
    expect(timers[0].due_on).toBe(addMonths(t.today, 36));
    const row = (
      await t.pool.query(
        "select contact_status, contact_status_note, contact_status_at, scheduled_call_at from clients where id = $1",
        [id],
      )
    ).rows[0];
    expect(row.contact_status).toBe("dnc");
    expect(row.contact_status_note).toBe("asked us to stop on the phone");
    expect(row.contact_status_at).toBeInstanceOf(Date);
    expect(row.scheduled_call_at).toBeNull();
    const last = (
      await t.pool.query(
        "select body from activities where client_id = $1 order by occurred_at desc limit 1",
        [id],
      )
    ).rows[0];
    expect(last.body).toBe("Contact status: Do not contact — asked us to stop on the phone");
  });
  it("a channel restriction leaves the timers alone", async () => {
    const id = await insertClient(t.db, a, "No Text Co");
    const before = await open(id);
    await t.db.withUser(a, (q) =>
      setContactStatus(q, contactStatusSchema.parse({ clientId: id, status: "no_text" })),
    );
    expect(await open(id)).toEqual(before);
    expect(
      (await t.pool.query("select contact_status from clients where id = $1", [id])).rows[0]
        .contact_status,
    ).toBe("no_text");
  });
  it("can be lifted again", async () => {
    const id = await insertClient(t.db, a, "Lifted Co");
    await t.db.withUser(a, (q) =>
      setContactStatus(q, contactStatusSchema.parse({ clientId: id, status: "dnc" })),
    );
    await t.db.withUser(a, (q) =>
      setContactStatus(q, contactStatusSchema.parse({ clientId: id, status: "ok" })),
    );
    expect(
      (await t.pool.query("select contact_status from clients where id = $1", [id])).rows[0]
        .contact_status,
    ).toBe("ok");
    expect((await open(id)).length).toBeGreaterThan(0);
  });
  it("rejects an unknown status and another user's client, changing nothing", async () => {
    const id = await insertClient(t.db, a, "Private Co");
    await expect(
      t.db.withUser(a, (q) => q.query("select * from set_contact_status($1, 'whatever')", [id])),
    ).rejects.toThrow(/unknown contact status/);
    await expect(
      t.db.withUser(b, (q) =>
        setContactStatus(q, contactStatusSchema.parse({ clientId: id, status: "dnc" })),
      ),
    ).rejects.toThrow(/client not found/);
    expect(
      (await t.pool.query("select contact_status from clients where id = $1", [id])).rows[0]
        .contact_status,
    ).toBe("ok");
    expect(await open(id)).toHaveLength(1);
  });
  it("the card view exposes the status", async () => {
    const id = await insertClient(t.db, a, "View Co");
    await t.db.withUser(a, (q) =>
      setContactStatus(
        q,
        contactStatusSchema.parse({ clientId: id, status: "no_call", note: "n" }),
      ),
    );
    const c = (
      await t.db.withUser(a, (q) =>
        q.query("select contact_status, contact_status_note from client_cards where id = $1", [id]),
      )
    ).rows[0];
    expect(c).toEqual({ contact_status: "no_call", contact_status_note: "n" });
  });
});

describe("the server refuses to contact someone who said stop", () => {
  it("logging a call, text or email for a do-not-contact merchant is refused — nothing is written", async () => {
    const id = await insertClient(t.db, a, "Refused Co");
    await t.db.withUser(a, (q) =>
      setContactStatus(q, contactStatusSchema.parse({ clientId: id, status: "dnc" })),
    );
    const before = (
      await t.pool.query("select count(*)::int n from activities where client_id = $1", [id])
    ).rows[0].n;
    for (const kind of ["call", "text", "email"] as const) {
      await expect(
        t.db.withUser(a, (q) =>
          logTouch(q, { clientId: id, kind, outcome: "reached", body: "", nextDueOn: d(3) }, ctx()),
        ),
      ).rejects.toThrow(/Marked do-not-contact/);
    }
    expect(
      (await t.pool.query("select count(*)::int n from activities where client_id = $1", [id]))
        .rows[0].n,
    ).toBe(before);
  });
  it("only the restricted channel is refused", async () => {
    const id = await insertClient(t.db, a, "Channel Co");
    await t.db.withUser(a, (q) =>
      setContactStatus(q, contactStatusSchema.parse({ clientId: id, status: "no_text" })),
    );
    await expect(t.db.withUser(a, (q) => assertContactAllowed(q, id, "text"))).rejects.toThrow(
      /Asked not to be texted/,
    );
    await t.db.withUser(a, (q) => assertContactAllowed(q, id, "call"));
    await t.db.withUser(a, (q) =>
      logTouch(
        q,
        { clientId: id, kind: "call", outcome: "reached", body: "fine", nextDueOn: d(3) },
        ctx(),
      ),
    );
  });
  it("Today never lists a do-not-contact merchant, even with a timer due", () => {
    const card = () =>
      ({
        id: "x",
        business_name: "X",
        stage: "interested",
        next_due_on: t.today,
        next_due_kind: "follow_up",
        contact_status: "ok",
        scheduled_call_at: null,
      }) as unknown as ClientCard;
    const cards = [
      { ...card(), id: "ok", business_name: "OK Co" },
      { ...card(), id: "dnc", business_name: "DNC Co", contact_status: "dnc" },
      {
        ...card(),
        id: "overdue-dnc",
        business_name: "Late DNC",
        contact_status: "dnc",
        next_due_on: addDays(t.today, -5),
      },
    ] as ClientCard[];
    const v = buildToday(cards, t.today);
    expect(v.dueToday.map((c) => c.id)).toEqual(["ok"]);
    expect(v.overdue).toEqual([]);
    expect(v.kpis.dueToday).toBe(1);
  });
});
