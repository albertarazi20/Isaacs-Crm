/**
 * Round 4, the outbox worker. Each finding is proved in the database, not at the call:
 *   1. bulk mail (sequence, blast) goes only inside the merchant's window at the moment it is sent;
 *   2. a database failure while recording a provider failure does not abort the run, and an answer that never came
 *      (a timeout) is failed for a person to check instead of being retried into a duplicate.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { enqueueEmail } from "@/lib/send/enqueue";
import { drainOutbox, isAmbiguousSendError, type Deliverer } from "@/lib/send/worker";
import type { Db, DbAccess } from "@/lib/db";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let n = 0;

// Monday 2026-11-16: 15:00Z is 10:00 in New York (inside the 9 to 11 window), 03:00Z next day is 22:00 (outside).
const IN_WINDOW = new Date("2026-11-16T15:00:00Z");
const AFTER_HOURS = new Date("2026-11-17T03:00:00Z");
const NEXT_MORNING = new Date("2026-11-17T15:00:00Z");

const sentVia: string[] = [];
const deliver: Deliverer = {
  gmail: async (_u, m) => (sentVia.push(m.subject), `g_${sentVia.length}`),
  resend: async (m) => (sentVia.push(m.subject), `r_${sentVia.length}`),
};
const run = (now: Date, d: Deliverer = deliver, db: DbAccess = t.db) =>
  drainOutbox({ db, deliver: d, now, appUrl: "https://crm.test" });

/** Makes the database refuse queries that match, `times` times. */
function flaky(match: RegExp, times: number): DbAccess {
  let left = times;
  return {
    withUser: (u, fn) => t.db.withUser(u, fn),
    withSystem: (fn) =>
      t.db.withSystem((q) => {
        const w: Db = Object.create(q);
        w.query = ((...a: unknown[]) => {
          const text = typeof a[0] === "string" ? a[0] : "";
          if (match.test(text) && left > 0) {
            left -= 1;
            return Promise.reject(new Error("injected failure"));
          }
          return (q.query as (...x: unknown[]) => unknown)(...a);
        }) as Db["query"];
        return fn(w);
      }),
  };
}

const merchant = async (): Promise<string> => {
  n += 1;
  return (
    await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Owner', '2125550100', $3, 'NY') returning id",
      [rep, `R4 Merchant ${n}`, `r4m${n}@x.com`],
    )
  ).rows[0]?.id as string;
};
const queue = async (
  lane: "sequence" | "blast" | "intake",
  subject: string,
  at = IN_WINDOW,
): Promise<string> => {
  const client = await merchant();
  const r = await t.db.withUser(rep, (q) =>
    enqueueEmail(
      q,
      {
        clientId: client,
        lane,
        source:
          lane === "blast"
            ? `blast:${n}:day`
            : lane === "sequence"
              ? `bucket:b${n}:step:1`
              : "intake",
        subject,
        text: "Hi",
      },
      at,
    ),
  );
  if (!r.queued) throw new Error("not queued");
  return r.outboxId;
};
const row = async (id: string) =>
  (
    await t.pool.query<{
      status: string;
      attempts: number;
      last_error: string | null;
      provider_id: string | null;
      not_before: Date;
    }>("select status, attempts, last_error, provider_id, not_before from outbox where id = $1", [
      id,
    ])
  ).rows[0];

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  await t.pool.query(
    "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status) values ($1, 'rep@selectivecap.com', 'enc', 'send', 'ok')",
    [rep],
  );
  await t.pool.query(
    "update shop_settings set postal_address = '1 Main St, Miami FL 33101', automation_from = ''",
  );
});
afterAll(async () => {
  await t.drop();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("bulk mail outside the send window", () => {
  it.each(["sequence", "blast"] as const)(
    "a due %s row found after hours is moved to the next slot in the window, not sent",
    async (lane) => {
      const id = await queue(lane, `After hours ${lane}`);
      const before = sentVia.length;
      const s = await run(AFTER_HOURS);
      expect(sentVia.length).toBe(before);
      expect(s).toMatchObject({ sent: 0, deferred: 1 });
      const r = await row(id);
      expect(r).toMatchObject({ status: "queued", attempts: 0, last_error: "outside_window" });
      // 22:00 New York on Monday: the next slot is Tuesday morning, 9 to 11 local (14:00Z to 16:00Z)
      expect(r?.not_before.getTime()).toBeGreaterThanOrEqual(
        new Date("2026-11-17T14:00:00Z").getTime(),
      );
      expect(r?.not_before.getTime()).toBeLessThan(new Date("2026-11-17T16:00:00Z").getTime());
      // and it does go once the window is open
      expect((await run(r?.not_before ?? NEXT_MORNING)).sent).toBe(1);
      expect((await row(id))?.status).toBe("sent");
    },
  );

  it("the same row inside the window is sent at once (the check does not block the normal case)", async () => {
    const id = await queue("sequence", "In hours");
    expect((await run(IN_WINDOW)).sent).toBe(1);
    expect((await row(id))?.status).toBe("sent");
  });

  it("replies and intake mail still go at any hour", async () => {
    const id = await queue("intake", "Welcome at night");
    expect((await run(AFTER_HOURS)).sent).toBe(1);
    expect((await row(id))?.status).toBe("sent");
  });

  it("a row left in 'sending' and queued again by the sweep after hours waits for the window", async () => {
    const id = await queue("sequence", "Swept after hours");
    await t.pool.query(
      "update outbox set status = 'sending', attempts = 1, not_before = $2 where id = $1",
      [id, IN_WINDOW],
    );
    const before = sentVia.length;
    await run(AFTER_HOURS);
    expect(sentVia.length).toBe(before);
    expect(await row(id)).toMatchObject({ status: "queued", last_error: "outside_window" });
  });
});

describe("a provider failure whose recording fails", () => {
  it("does not abort the run: the other rows still go", async () => {
    const a = await queue("intake", "Provider rejects A");
    const b = await queue("intake", "Provider fine B");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rejecting: Deliverer = {
      gmail: async (_u, m) => {
        if (m.subject === "Provider rejects A") throw new Error("provider 500");
        return deliver.gmail(_u, m);
      },
      resend: deliver.resend,
    };
    // the write that records the failure (queue it again) is refused
    const s = await run(
      IN_WINDOW,
      rejecting,
      flaky(/set status = 'queued', provider_id = null/, 1),
    );
    expect(s.sent).toBe(1);
    expect((await row(b))?.status).toBe("sent");
    // the failure of A is logged with its id; the row waits in 'sending' for the sweep
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain(a);
    expect(await row(a)).toMatchObject({ status: "sending", provider_id: "pending" });
  });
});

describe("an answer that never came", () => {
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const failWith = (e: unknown): Deliverer => ({
    gmail: async () => {
      throw e;
    },
    resend: deliver.resend,
  });

  it("a timeout is failed at once for a person to check, never retried", async () => {
    const id = await queue("intake", "Timed out");
    const s = await run(IN_WINDOW, failWith(timeout));
    expect(s).toMatchObject({ sent: 0, failed: 1, deferred: 0 });
    const r = await row(id);
    expect(r).toMatchObject({ status: "failed", attempts: 1, provider_id: null });
    expect(r?.last_error).toContain("it may have gone out");
    // later runs never pick it up again
    const before = sentVia.length;
    await run(new Date(IN_WINDOW.getTime() + 3_600_000));
    expect(sentVia.length).toBe(before);
    expect((await row(id))?.status).toBe("failed");
  });

  it("a dropped connection (the request may have arrived) is treated the same way", async () => {
    const id = await queue("intake", "Connection reset");
    const e = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    await run(IN_WINDOW, failWith(e));
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("an error the provider answered with is still retried", async () => {
    const id = await queue("intake", "Provider 503");
    await run(IN_WINDOW, failWith(new Error("Resend failed (503)")));
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 1, provider_id: null });
    await t.pool.query("update outbox set status = 'cancelled' where id = $1", [id]);
  });

  it("a refused connection (nothing was sent) is still retried", async () => {
    const id = await queue("intake", "Refused");
    const e = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    await run(IN_WINDOW, failWith(e));
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 1 });
    await t.pool.query("update outbox set status = 'cancelled' where id = $1", [id]);
  });

  it("classifies errors", () => {
    expect(isAmbiguousSendError(timeout)).toBe(true);
    expect(isAmbiguousSendError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAmbiguousSendError(new Error("Gmail send failed (500)"))).toBe(false);
    expect(isAmbiguousSendError("boom")).toBe(false);
    expect(isAmbiguousSendError(null)).toBe(false);
  });
});
