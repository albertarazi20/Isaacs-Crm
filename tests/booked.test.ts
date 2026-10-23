import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listCards } from "@/lib/data/queries";
import * as m from "@/lib/data/mutations";
import type { ClientCard } from "@/lib/data/types";
import { buildToday } from "@/lib/data/views";
import { bookedTime, bookedToday } from "@/lib/mca/booked";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

describe("bookedToday / bookedTime", () => {
  it("uses the user's own day: 10 PM in New York is already tomorrow in UTC", () => {
    const card = { scheduled_call_at: "2026-10-24T02:00:00Z" };
    expect(bookedToday(card, "2026-10-23", "America/New_York")).toBe(true);
    expect(bookedToday(card, "2026-10-23", "UTC")).toBe(false);
    expect(bookedTime(card, "America/New_York")).toBe("10:00 PM");
  });
  it("nothing booked, or garbage, is not an appointment", () => {
    expect(bookedToday({ scheduled_call_at: null }, "2026-10-23", "UTC")).toBe(false);
    expect(bookedToday({ scheduled_call_at: "not a date" }, "2026-10-23", "UTC")).toBe(false);
    expect(bookedTime({ scheduled_call_at: null }, "UTC")).toBeNull();
  });
});

const card = (over: Partial<ClientCard>): ClientCard =>
  ({
    id: over.business_name ?? "c",
    business_name: "X",
    contact_status: "ok",
    stage: "interested",
    scheduled_call_at: null,
    next_due_kind: "follow_up",
    funding_status: null,
    ...over,
  }) as ClientCard;

describe("buildToday puts an appointment in 'Calls booked today' however it ties", () => {
  const today = "2026-10-23";
  const tz = "America/New_York";
  it("an older follow-up due the same day does not hide it", () => {
    const v = buildToday(
      [
        card({
          business_name: "Call Co",
          next_due_on: today,
          scheduled_call_at: "2026-10-23T19:00:00Z",
        }),
      ],
      today,
      tz,
    );
    expect(v.scheduled.map((c) => c.business_name)).toEqual(["Call Co"]);
    expect(v.dueToday).toEqual([]);
  });
  it("neither does an OVERDUE follow-up: it is today's appointment, not a pile-up", () => {
    const v = buildToday(
      [
        card({
          business_name: "Late Co",
          next_due_on: "2026-10-20",
          scheduled_call_at: "2026-10-23T19:00:00Z",
        }),
      ],
      today,
      tz,
    );
    expect(v.scheduled).toHaveLength(1);
    expect(v.overdue).toEqual([]);
    expect(v.kpis).toMatchObject({ overdue: 0, dueToday: 1 });
  });
  it("appointments run earliest first", () => {
    const v = buildToday(
      [
        card({
          business_name: "Late",
          next_due_on: today,
          scheduled_call_at: "2026-10-23T21:00:00Z",
        }),
        card({
          business_name: "Early",
          next_due_on: today,
          scheduled_call_at: "2026-10-23T14:00:00Z",
        }),
      ],
      today,
      tz,
    );
    expect(v.scheduled.map((c) => c.business_name)).toEqual(["Early", "Late"]);
  });
  it("a call booked for another day changes nothing", () => {
    const v = buildToday(
      [
        card({
          business_name: "Tomorrow Co",
          next_due_on: today,
          scheduled_call_at: "2026-10-24T19:00:00Z",
        }),
      ],
      today,
      tz,
    );
    expect(v.scheduled).toEqual([]);
    expect(v.dueToday).toHaveLength(1);
  });
  it("every merchant appears in exactly one list", () => {
    const cards = [
      card({ business_name: "A", next_due_on: today, scheduled_call_at: "2026-10-23T19:00:00Z" }),
      card({ business_name: "B", next_due_on: "2026-10-20" }),
      card({ business_name: "C", next_due_on: today }),
      card({ business_name: "D", next_due_on: "2026-10-25" }),
      card({
        business_name: "E",
        next_due_on: "2026-10-21",
        scheduled_call_at: "2026-10-23T15:00:00Z",
      }),
    ];
    const v = buildToday(cards, today, tz);
    const all = [...v.scheduled, ...v.overdue, ...v.dueToday, ...v.upcoming].map(
      (c) => c.business_name,
    );
    expect([...all].sort()).toEqual(["A", "B", "C", "D", "E"]);
  });
});

describe("from a real database: log a call, then book the next one", () => {
  let t: TestDb;
  let a: string;
  beforeAll(async () => {
    t = await createTestDb();
    a = await insertUser(t.pool, "isaac@x.com", "UTC");
  });
  afterAll(async () => {
    await t.drop();
  });
  it("the follow-up due today and a call at 11 PM today: the card is an appointment", async () => {
    const id = await insertClient(t.db, a, "Evening Call Pizza", t.today);
    await t.db.withUser(a, (q) =>
      m.scheduleCall(
        q,
        { clientId: id, at: `${t.today}T23:00:00Z`, note: "" },
        { today: t.today, timezone: "UTC" },
      ),
    );
    const cards = await t.db.withUser(a, (q) => listCards(q));
    expect(cards[0]?.next_due_kind).toBe("follow_up"); // the older timer still wins the card's "next due"
    const v = buildToday(cards, t.today, "UTC");
    expect(v.scheduled.map((c) => c.id)).toEqual([id]);
    expect(v.dueToday).toEqual([]);
  });
});
