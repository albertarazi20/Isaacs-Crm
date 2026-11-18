import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopEmailsForGood, turnEmailsBackOn } from "@/lib/approvals/hardStop";
import { unsubscribeByToken } from "@/lib/system/replies";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * merge_clients (0561) kept email_opt_out but not the hand stop (0580), so a merged card stayed blocked but read
 * "they unsubscribed". 0581 carries emails_stopped_at / emails_stopped_by over: the earlier of the two, whoever set it.
 * Every claim is read back from the DATABASE.
 */

let t: TestDb;
let rep: string;
let boss: string;
const REP = { userId: "", email: "rep@crm.test" };
const BOSS = { userId: "", email: "boss@crm.test" };

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0] as T;

let n = 0;
async function card(): Promise<{ id: string; email: string; token: string }> {
  n += 1;
  const email = `owner${n}@shop${n}.test`;
  const r = await one<{ id: string; token: string }>(
    `insert into clients (user_id, business_name, contact_name, phone, email, state)
     values ($1, $2, 'rosa diaz', $3, $4, 'FL') returning id, unsubscribe_token as token`,
    [rep, `Shop ${n}`, `30555508${String(n).padStart(2, "0")}`, email],
  );
  return { ...r, email };
}
/** Stop a card's emails by hand as `who`, then date the stop (the earlier-of-the-two rule needs known times). */
async function stopAt(id: string, who: typeof REP, at: string) {
  await stopEmailsForGood(t.db, who, id);
  await t.pool.query("update clients set emails_stopped_at = $2 where id = $1", [id, at]);
}
const merge = (keep: string, drop: string) =>
  t.db.withUser(rep, (q) => q.query("select * from merge_clients($1, $2)", [keep, drop]));
const flags = (id: string) =>
  one<{ email_opt_out: boolean; at: string | null; by: string | null }>(
    "select email_opt_out, emails_stopped_at::text as at, emails_stopped_by::text as by from clients where id = $1",
    [id],
  );
const at = (iso: string) =>
  one<{ at: string }>("select $1::timestamptz::text as at", [iso]).then((r) => r.at);

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, REP.email, "America/New_York");
  boss = await insertUser(t.pool, BOSS.email);
  REP.userId = rep;
  BOSS.userId = boss;
  await t.pool.query("update app_users set role = 'manager', name = 'amy boss' where id = $1", [
    boss,
  ]);
});
afterAll(async () => {
  await t.drop();
});

describe("merging cards keeps a hand stop", () => {
  it("the other card was stopped by hand: the kept card is stopped too, by the same person, from the same time", async () => {
    const keep = await card();
    const drop = await card();
    await stopAt(drop.id, BOSS, "2026-11-10T15:00:00Z");
    expect(await flags(keep.id)).toEqual({ email_opt_out: false, at: null, by: null });
    await merge(keep.id, drop.id);
    expect(await flags(keep.id)).toEqual({
      email_opt_out: true,
      at: await at("2026-11-10T15:00:00Z"),
      by: boss,
    });
    // the hand-stop suppression went with the card, and a manager can still turn the emails back on
    expect(
      await one(
        "select count(*)::int as n from suppressions where client_id = $1 and reason = 'manual'",
        [keep.id],
      ),
    ).toEqual({ n: 1 });
    expect(await turnEmailsBackOn(t.db, BOSS, keep.id)).toEqual({ changed: true });
    expect(await flags(keep.id)).toEqual({ email_opt_out: false, at: null, by: null });
    expect(
      await one("select count(*)::int as n from suppressions where client_id = $1", [keep.id]),
    ).toEqual({ n: 0 });
  });

  it("the kept card was stopped by hand and the other was not: nothing changes", async () => {
    const keep = await card();
    const drop = await card();
    await stopAt(keep.id, REP, "2026-11-12T15:00:00Z");
    await merge(keep.id, drop.id);
    expect(await flags(keep.id)).toEqual({
      email_opt_out: true,
      at: await at("2026-11-12T15:00:00Z"),
      by: rep,
    });
  });

  it("both were stopped: the earlier stop (and who set it) wins, whichever card it was on", async () => {
    const k1 = await card();
    const d1 = await card();
    await stopAt(k1.id, REP, "2026-11-12T15:00:00Z");
    await stopAt(d1.id, BOSS, "2026-11-09T15:00:00Z");
    await merge(k1.id, d1.id);
    expect(await flags(k1.id)).toMatchObject({ at: await at("2026-11-09T15:00:00Z"), by: boss });

    const k2 = await card();
    const d2 = await card();
    await stopAt(k2.id, REP, "2026-11-08T15:00:00Z");
    await stopAt(d2.id, BOSS, "2026-11-13T15:00:00Z");
    await merge(k2.id, d2.id);
    expect(await flags(k2.id)).toMatchObject({ at: await at("2026-11-08T15:00:00Z"), by: rep });
  });

  it("a merchant's own unsubscribe on the other card still blocks the merged card for good, and the hand stop does not hide it", async () => {
    const keep = await card();
    const drop = await card();
    await stopAt(keep.id, REP, "2026-11-12T15:00:00Z");
    await unsubscribeByToken(t.db, drop.token, "page");
    await merge(keep.id, drop.id);
    expect(await flags(keep.id)).toMatchObject({ email_opt_out: true, by: rep });
    await expect(turnEmailsBackOn(t.db, BOSS, keep.id)).rejects.toMatchObject({
      code: "22023",
      message: expect.stringMatching(/also asked not to be emailed/),
    });
    expect(await flags(keep.id)).toMatchObject({ email_opt_out: true });
  });

  it("two cards that were never stopped by hand: no hand stop appears, and an unsubscribe still carries over as one", async () => {
    const keep = await card();
    const drop = await card();
    await unsubscribeByToken(t.db, drop.token, "page");
    await merge(keep.id, drop.id);
    expect(await flags(keep.id)).toEqual({ email_opt_out: true, at: null, by: null });
    const plainKeep = await card();
    const plainDrop = await card();
    await merge(plainKeep.id, plainDrop.id);
    expect(await flags(plainKeep.id)).toEqual({ email_opt_out: false, at: null, by: null });
  });

  it("the dropped card's hand-stop person being gone does not break the merge (the stop stays, with no name)", async () => {
    const keep = await card();
    const drop = await card();
    await stopAt(drop.id, BOSS, "2026-11-10T15:00:00Z");
    await t.pool.query("update clients set emails_stopped_by = null where id = $1", [drop.id]);
    await merge(keep.id, drop.id);
    expect(await flags(keep.id)).toEqual({
      email_opt_out: true,
      at: await at("2026-11-10T15:00:00Z"),
      by: null,
    });
  });
});
