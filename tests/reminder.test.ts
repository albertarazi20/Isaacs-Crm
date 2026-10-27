import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as m from "@/lib/data/mutations";
import { listCards } from "@/lib/data/queries";
import { addDays } from "@/lib/mca/dates";
import { buildCallReminder } from "@/lib/mca/digest";
import { reminderText } from "@/lib/mca/reminder";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

describe("reminderText", () => {
  const tz = "America/New_York";
  it("says the time for today, the weekday for a later day, overdue for a past day", () => {
    expect(reminderText("2026-10-27T19:15:00Z", "text", tz, "2026-10-27")).toBe("Text 3:15 PM");
    expect(reminderText("2026-10-29T13:00:00Z", "email", tz, "2026-10-27")).toBe(
      "Email Thu 9:00 AM",
    );
    expect(reminderText("2026-10-25T13:00:00Z", "call", tz, "2026-10-27")).toBe("Call overdue");
  });
  it("treats a missing channel as a call", () => {
    expect(reminderText("2026-10-27T19:15:00Z", null, tz, "2026-10-27")).toBe("Call 3:15 PM");
  });
});

describe("the reminder email", () => {
  const base = {
    clientId: "c1",
    businessName: "Text Me Tacos",
    contactName: "Maria",
    phone: "5551234567",
    callTime: "3:15 PM",
    wantedAmount: null,
    lastCallNote: null,
    positionCount: 0,
  };
  it("names the channel in the subject, and defaults to a call", () => {
    expect(buildCallReminder({ ...base, channel: "text" }, "https://x").subject).toBe(
      "Text at 3:15 PM: Text Me Tacos",
    );
    expect(buildCallReminder({ ...base, channel: "email" }, "https://x").subject).toMatch(
      /^Email at /,
    );
    expect(buildCallReminder(base, "https://x").subject).toBe("Call at 3:15 PM: Text Me Tacos");
  });
});

describe("a reminder with a channel, from a real database", () => {
  let t: TestDb;
  let user: string;
  beforeAll(async () => {
    t = await createTestDb();
    user = await insertUser(t.pool, "isaac@x.com", "UTC");
  });
  afterAll(async () => {
    await t.drop();
  });

  it("saves the channel on the timer and shows it on the card; rebooking replaces it", async () => {
    const id = await insertClient(t.db, user, "Text Me Tacos", t.today);
    const ctx = { today: t.today, timezone: "UTC" };
    const at = `${addDays(t.today, 3)}T15:00`;

    await t.db.withUser(user, (q) =>
      m.scheduleCall(q, { clientId: id, at, note: "", channel: "text" }, ctx),
    );
    const open = await t.pool.query(
      "select channel from timers where client_id = $1 and kind = 'scheduled_call' and done_at is null",
      [id],
    );
    expect(open.rows).toEqual([{ channel: "text" }]);
    let card = (await t.db.withUser(user, (q) => listCards(q))).find((c) => c.id === id);
    expect(card?.reminder_channel).toBe("text");
    expect(card?.scheduled_call_at).not.toBeNull();

    await t.db.withUser(user, (q) =>
      m.scheduleCall(q, { clientId: id, at, note: "", channel: "email" }, ctx),
    );
    card = (await t.db.withUser(user, (q) => listCards(q))).find((c) => c.id === id);
    expect(card?.reminder_channel).toBe("email");
    const still = await t.pool.query(
      "select count(*)::int as n from timers where client_id = $1 and kind = 'scheduled_call' and done_at is null",
      [id],
    );
    expect(still.rows[0].n).toBe(1);
  });

  it("is a call when no channel is given, and cancelling clears it", async () => {
    const id = await insertClient(t.db, user, "Plain Call Pizza", t.today);
    const ctx = { today: t.today, timezone: "UTC" };
    await t.db.withUser(user, (q) =>
      m.scheduleCall(q, { clientId: id, at: `${addDays(t.today, 3)}T15:00`, note: "" }, ctx),
    );
    let card = (await t.db.withUser(user, (q) => listCards(q))).find((c) => c.id === id);
    expect(card?.reminder_channel).toBe("call");
    await t.db.withUser(user, (q) => m.cancelCall(q, id));
    card = (await t.db.withUser(user, (q) => listCards(q))).find((c) => c.id === id);
    expect(card?.reminder_channel ?? null).toBeNull();
    expect(card?.scheduled_call_at).toBeNull();
  });

  it("logging a text finishes a text reminder, and logging a call does not", async () => {
    const id = await insertClient(t.db, user, "Text Then Call Co", t.today);
    const ctx = { today: t.today, timezone: "UTC" };
    const soon = new Date(Date.now() + 3_600_000).toISOString().slice(0, 16);
    await t.db.withUser(user, (q) =>
      m.scheduleCall(q, { clientId: id, at: soon, note: "", channel: "text" }, ctx),
    );
    const touch = (kind: "call" | "text") =>
      t.db.withUser(user, (q) =>
        m.logTouch(
          q,
          { clientId: id, kind, outcome: "reached", body: "", nextDueOn: addDays(t.today, 3) },
          ctx,
        ),
      );
    const open = async () =>
      (
        await t.pool.query(
          "select 1 from timers where client_id = $1 and kind = 'scheduled_call' and done_at is null",
          [id],
        )
      ).rowCount;

    await touch("call");
    expect(await open()).toBe(1);
    const stillSet = await t.pool.query("select scheduled_call_at from clients where id = $1", [
      id,
    ]);
    expect(stillSet.rows[0].scheduled_call_at).not.toBeNull();

    await touch("text");
    expect(await open()).toBe(0);
    const cleared = await t.pool.query("select scheduled_call_at from clients where id = $1", [id]);
    expect(cleared.rows[0].scheduled_call_at).toBeNull();
  });
});
