import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleResendEvent } from "@/lib/system/replies";
import { isOptOutText } from "@/lib/messaging/stop";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

/**
 * A STOP from a merchant's exact address whose sender check failed (a forwarder, a misaligned third-party sender, no
 * Authentication-Results) is still honoured: a missed STOP is a compliance problem, a spoofed one costs one lead.
 * The database says what happened.
 */

let t: TestDb;
let rep: string;
let bucket: string;

const row = async (id: string) =>
  (
    await t.pool.query<{
      email_opt_out: boolean;
      reply_waiting_since: string | null;
    }>("select email_opt_out, reply_waiting_since::text from clients where id = $1", [id])
  ).rows[0]!;
const stopReason = async (id: string) =>
  (
    await t.pool.query<{ stop_reason: string | null }>(
      "select stop_reason from enrollments where client_id = $1 order by created_at desc limit 1",
      [id],
    )
  ).rows[0]?.stop_reason ?? null;
const notes = async (id: string) =>
  (
    await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and kind = 'system' and body like 'Opted out of email from an unverified sender%'",
      [id],
    )
  ).rows;
const newClient = async (name: string, email: string) => {
  const id = await insertClient(t.db, rep, name);
  await t.pool.query("update clients set email = $2 where id = $1", [id, email]);
  await t.pool.query("select enroll_in_bucket($1, $2, 'moved')", [id, bucket]);
  return id;
};

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  bucket = (
    await t.pool.query<{ id: string }>(
      "select id from buckets where key = 'missing_statements' limit 1",
    )
  ).rows[0]!.id;
});
afterAll(async () => {
  await t.drop();
});

describe("an unverified STOP from a known merchant address", () => {
  it("opts the merchant out, stops the sequence and leaves a timeline note", async () => {
    const id = await newClient("Fwd Pizza", "fwd@pizza.com");
    expect(
      await handleResendEvent(t.db, "evt_u1", {
        type: "email.received",
        data: {
          from: "Fwd <fwd@pizza.com>",
          subject: "Re: docs",
          text: "Stop\n\nSent from my iPhone",
        },
      }),
    ).toEqual({ result: "received:unverified_stop" });
    expect((await row(id)).email_opt_out).toBe(true);
    expect(await stopReason(id)).toBe("opted_out");
    const n = await notes(id);
    expect(n).toHaveLength(1);
    expect(n[0]?.body).toContain("fwd@pizza.com");
    // the address is suppressed shop-wide, the same as a verified STOP
    expect(
      (await t.pool.query("select 1 from suppressions where display = 'fwd@pizza.com'")).rowCount,
    ).toBe(1);
    // nothing else of an unverified mail is trusted: no reply flag
    expect((await row(id)).reply_waiting_since).toBeNull();
  });

  it("a second unverified STOP does not repeat the note", async () => {
    await handleResendEvent(t.db, "evt_u1b", {
      type: "email.received",
      data: { from: "fwd@pizza.com", subject: "Re: docs", text: "STOP" },
    });
    expect(
      await notes(
        (await t.pool.query<{ id: string }>("select id from clients where email = 'fwd@pizza.com'"))
          .rows[0]!.id,
      ),
    ).toHaveLength(1);
  });

  it("an unverified mail that is not a STOP changes nothing", async () => {
    const id = await newClient("Quiet Taco", "quiet@taco.com");
    expect(
      await handleResendEvent(t.db, "evt_u2", {
        type: "email.received",
        data: { from: "quiet@taco.com", subject: "Re: docs", text: "Can you stop by tomorrow?" },
      }),
    ).toEqual({ result: "received:unverified_sender" });
    expect((await row(id)).email_opt_out).toBe(false);
    expect(await stopReason(id)).toBeNull();
    expect(await notes(id)).toHaveLength(0);
    expect((await row(id)).reply_waiting_since).toBeNull();
  });

  it("an address that is not a merchant's is never opted out", async () => {
    expect(
      await handleResendEvent(t.db, "evt_u3", {
        type: "email.received",
        data: { from: "stranger@nowhere.com", subject: "x", text: "STOP" },
      }),
    ).toEqual({ result: "received:unknown_sender" });
  });
});

describe("isOptOutText on bare keywords", () => {
  it("counts a bare keyword only in a short reply", () => {
    expect(isOptOutText("you've emailed me 5 times. stop.")).toBe(true);
    const long = `${"word ".repeat(30)}. stop.`;
    expect(isOptOutText(long)).toBe(false);
  });
});
