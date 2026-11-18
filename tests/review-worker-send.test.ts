import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { enqueueEmail } from "@/lib/send/enqueue";
import { drainOutbox, mailboxFor, type Deliverer } from "@/lib/send/worker";
import type { Db, DbAccess } from "@/lib/db";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let n = 0;

const T0 = new Date("2026-11-16T15:00:00Z");
const minutes = (m: number) => new Date(T0.getTime() + m * 60_000);

const sentVia: string[] = [];
const deliver: Deliverer = {
  gmail: async (_u, m) => (sentVia.push(m.subject), `g_${sentVia.length}`),
  resend: async (m) => (sentVia.push(m.subject), `r_${sentVia.length}`),
};

/** Makes the database refuse queries that match: `times` times (Infinity: always), with the given pg error code. */
function flaky(match: RegExp, times: number, code?: string): DbAccess {
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
            return Promise.reject(Object.assign(new Error("injected failure"), { code }));
          }
          return (q.query as (...x: unknown[]) => unknown)(...a);
        }) as Db["query"];
        return fn(w);
      }),
  };
}

const queue = async (subject: string): Promise<string> => {
  n += 1;
  const client = (
    await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Owner', '3105550100', $3, 'CA') returning id",
      [rep, `Merchant ${n}`, `m${n}@x.com`],
    )
  ).rows[0]?.id as string;
  const r = await t.db.withUser(rep, (q) =>
    enqueueEmail(
      q,
      { clientId: client, lane: "intake", source: "intake", subject, text: "Hi" },
      T0,
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
const run = (db: DbAccess, now: Date) =>
  drainOutbox({ db, deliver, now, appUrl: "https://crm.test" });

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  await t.pool.query(
    "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status) values ($1, 'rep@selectivecap.com', 'enc', 'send', 'ok')",
    [rep],
  );
  await t.pool.query("update shop_settings set postal_address = '1 Main St, Miami FL 33101'");
});
afterAll(async () => {
  await t.drop();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a failure while preparing a claimed row", () => {
  it("a transient database error counts an attempt and retries later: the mail is not lost", async () => {
    const id = await queue("Transient");
    const s = await run(flaky(/mailbox_sent_24h/, 1), T0);
    expect(s.failed).toBe(0);
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 1 });
    expect((await row(id))?.last_error).toContain("could not prepare");
    expect((await row(id))?.not_before.getTime()).toBe(minutes(15).getTime());
    // not due yet: nothing happens; once due it goes
    expect((await run(t.db, minutes(5))).sent).toBe(0);
    expect((await run(t.db, minutes(16))).sent).toBe(1);
    expect(await row(id)).toMatchObject({ status: "sent" });
  });
  it("keeps failing: failed once the attempts run out, not before", async () => {
    const id = await queue("Always");
    const db = flaky(/mailbox_sent_24h/, Infinity);
    await run(db, minutes(100));
    await run(db, minutes(200));
    expect((await row(id))?.status).toBe("queued");
    await run(db, minutes(400));
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 3 });
  });
  it("an error that will come again (a data or integrity error) fails the row at once, alone", async () => {
    const bad = await queue("Bad");
    const good = await queue("Good");
    // only the first claim hits it; the other row still goes in the same run
    const s = await run(flaky(/mailbox_sent_24h/, 1, "22023"), minutes(600));
    expect(await row(bad)).toMatchObject({ status: "failed", attempts: 1 });
    expect(s.failed).toBe(1);
    expect((await row(good))?.status).toBe("sent");
  });
});

describe("rows stuck in 'sending'", () => {
  it("one that never reached the provider is queued again and sent; one that did is failed, never resent", async () => {
    const never = await queue("Never reached");
    const maybe = await queue("Maybe sent");
    await t.pool.query(
      "update outbox set status = 'sending', not_before = $2, attempts = 1 where id = $1",
      [never, minutes(700)],
    );
    await t.pool.query(
      "update outbox set status = 'sending', provider_id = 'pending', not_before = $2, attempts = 1 where id = $1",
      [maybe, minutes(700)],
    );
    const before = sentVia.length;
    const s = await run(t.db, minutes(760));
    expect(s.failed).toBe(1);
    expect(await row(maybe)).toMatchObject({ status: "failed" });
    expect((await row(maybe))?.last_error).toContain("may have gone out");
    expect(await row(never)).toMatchObject({ status: "sent" });
    expect(sentVia.slice(before)).toEqual(["Never reached"]);
  });
  it("a retry after a failed send does not carry the marker into the next claim", async () => {
    const id = await queue("Provider hiccup");
    const failing: Deliverer = {
      gmail: async () => {
        throw new Error("provider 500");
      },
      resend: deliver.resend,
    };
    await drainOutbox({
      db: t.db,
      deliver: failing,
      now: minutes(800),
      appUrl: "https://crm.test",
    });
    expect(await row(id)).toMatchObject({ status: "queued", provider_id: null, attempts: 1 });
    await t.pool.query("update outbox set status = 'cancelled' where id = $1", [id]);
  });
});

describe("the bookkeeping after the provider accepted the email", () => {
  it("both writes failing does not abort the run: the other rows still go, nothing is sent twice", async () => {
    const a = await queue("Ledger down A");
    const b = await queue("Ledger down B");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = sentVia.length;
    const s = await run(flaky(/set status = 'sent'/, Infinity), minutes(900));
    expect(s.sent).toBe(2);
    expect(sentVia.length - before).toBe(2);
    // the rows say 'sending' with the marker, so nothing claims them again
    expect(await row(a)).toMatchObject({ status: "sending", provider_id: "pending" });
    expect(await row(b)).toMatchObject({ status: "sending", provider_id: "pending" });
    const logged = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain(a);
    expect(logged).toContain("provider id");
    // later the sweep marks them for a person; the email is still never sent again
    expect((await run(t.db, minutes(1000))).sent).toBe(0);
    expect(sentVia.length - before).toBe(2);
    expect((await row(a))?.status).toBe("failed");
  });
});

describe("mailboxFor (gmail)", () => {
  const mb = (u: string, address: string, limit = 2000) =>
    t.db.withSystem((q) => mailboxFor(q, "gmail", u, address, limit));
  const limitOf = async (id: string) =>
    (
      await t.pool.query<{ provider_limit: number }>(
        "select provider_limit from mailboxes where id = $1",
        [id],
      )
    ).rows[0]?.provider_limit;

  it("does not overwrite a limit set by hand when the address has not changed", async () => {
    const u = await insertUser(t.pool, "limit@x.com");
    const id = await mb(u, "limit@work.com");
    await t.pool.query("update mailboxes set provider_limit = 777 where id = $1", [id]);
    expect(await mb(u, "limit@work.com")).toBe(id);
    expect(await limitOf(id)).toBe(777);
  });
  it("a rep who reconnects as another account keeps their row, moved, with the new default limit", async () => {
    const u = await insertUser(t.pool, "move@x.com");
    const id = await mb(u, "old@work.com");
    expect(await mb(u, "new@gmail.com", 500)).toBe(id);
    const r = await t.pool.query<{ address: string; provider_limit: number }>(
      "select address, provider_limit from mailboxes where id = $1",
      [id],
    );
    expect(r.rows[0]).toEqual({ address: "new@gmail.com", provider_limit: 500 });
  });
  it("an address another rep already holds is that mailbox: no unique violation, no second row", async () => {
    const u1 = await insertUser(t.pool, "one@x.com");
    const u2 = await insertUser(t.pool, "two@x.com");
    const first = await mb(u1, "shared@work.com");
    const own = await mb(u2, "second-own@work.com");
    expect(await mb(u2, "shared@work.com")).toBe(first);
    const rows = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from mailboxes where kind = 'gmail' and user_id in ($1, $2)",
      [u1, u2],
    );
    expect(rows.rows[0]?.n).toBe(2);
    expect(own).not.toBe(first);
  });
});
