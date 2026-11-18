import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importRawRows } from "@/lib/data/import";
import { assertEmailQuota, logTouch } from "@/lib/data/mutations";
import { importRowSchema } from "@/lib/data/schemas";
import { buildRows, guessMapping } from "@/lib/import/map";
import { intakeSchema } from "@/lib/leads/form";
import { leadSchema, toNewClient } from "@/lib/leads/schema";
import { addDays, addMonths } from "@/lib/mca/dates";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

const TODAY = "2026-10-23";
const headers = ["Business", "Phone", "Email", "Status", "Amount"];
const map = guessMapping(headers);
const opts = { today: TODAY, spreadDays: 3 };

describe("import rows built from a file", () => {
  it("an email that is not one address is left out with a note, and the row still passes the server schema", () => {
    for (const bad of ["n/a", "none", "a@x.com / b@x.com"]) {
      const { rows, problems } = buildRows(
        [["Joe Plumbing", "3055550001", bad, "", ""]],
        map,
        opts,
      );
      expect(rows[0]?.email).toBe("");
      expect(problems.some((p) => p.message.includes("isn't an email"))).toBe(true);
      expect(importRowSchema.safeParse(rows[0]).success).toBe(true);
    }
    const ok = buildRows([["Joe", "3055550001", "joe@x.com", "", ""]], map, opts);
    expect(ok.rows[0]?.email).toBe("joe@x.com");
  });
  it("a merchant marked not interested waits the stage's months, not a few days", () => {
    const { rows } = buildRows(
      [
        ["Gone Co", "3055550001", "", "Not interested", ""],
        ["Live Co", "3055550002", "", "", ""],
      ],
      map,
      opts,
    );
    expect(rows[0]?.stage).toBe("not_interested");
    expect(rows[0]?.followUpOn).toBe(addMonths(TODAY, 9));
    expect((rows[1]?.followUpOn ?? "") <= addDays(TODAY, 3)).toBe(true);
  });
});

describe("lead and intake input", () => {
  it("a good lead with a placeholder email or amount is kept, the words go to the notes", () => {
    const r = leadSchema.safeParse({
      phone: "5551234567",
      email: "none",
      wantedAmount: "ASAP",
      businessName: "Joe Plumbing",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.email).toBeUndefined();
    expect(r.data.wantedAmount).toBeUndefined();
    expect(r.data.notes).toContain("ASAP");
    expect(() => toNewClient(r.data, TODAY)).not.toThrow();
  });
  it("the intake form refuses an SSN and line breaks like every other entry point", () => {
    const base = { phone: "5551234567" };
    expect(
      intakeSchema.safeParse({ ...base, lookingFor: "SSN 123-45-6789, wants 50k" }).success,
    ).toBe(false);
    expect(intakeSchema.safeParse({ ...base, businessName: "Joe\nPlumbing" }).success).toBe(false);
    expect(intakeSchema.safeParse({ ...base, lookingFor: "a truck,\nand a van" }).success).toBe(
      true,
    );
  });
});

describe("with a database", () => {
  let t: TestDb;
  let rep: string;
  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "rep@x.com", "UTC");
  });
  afterAll(async () => {
    await t.drop();
  });

  it("one row the schema refuses lands in failed; the rest of the batch is imported", async () => {
    const good = (n: number) => ({
      line: n,
      businessName: `Biz ${n}`,
      phone: `30555500${String(n).padStart(2, "0")}`,
      stage: "name_in",
      followUpOn: addDays(t.today, 1),
    });
    const result = await t.db.withUser(rep, (q) =>
      importRawRows(
        q,
        { rows: [good(2), { ...good(3), email: "n/a" }, good(4)] },
        { today: t.today, timezone: "UTC" },
      ),
    );
    expect(result.created).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.line).toBe(3);
    const n = await t.pool.query(
      "select count(*)::int as n from clients where business_name like 'Biz %'",
    );
    expect(n.rows[0]?.n).toBe(2);
  });

  it("an email touch with no date keeps an Application-in merchant on that stage's pace", async () => {
    const id = await insertClient(t.db, rep, "App Co");
    await t.pool.query("update clients set stage = 'application_in' where id = $1", [id]);
    await t.db.withUser(rep, (q) =>
      logTouch(
        q,
        { clientId: id, kind: "email", outcome: null, body: "hi" },
        { today: t.today, timezone: "UTC" },
      ),
    );
    const due = await t.pool.query<{ d: string }>(
      "select min(due_on)::text as d from timers where client_id = $1 and done_at is null",
      [id],
    );
    expect(due.rows[0]?.d).toBe(addDays(t.today, 1));
  });

  it("a merchant's reply does not count against the daily email limit", async () => {
    const id = await insertClient(t.db, rep, "Reply Co");
    await t.pool.query(
      "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'email', 'Merchant replied: Re: hi')",
      [rep, id],
    );
    const before = Number(
      (await t.pool.query("select count(*) as n from activities where kind = 'email'")).rows[0]?.n,
    );
    expect(before).toBeGreaterThan(0);
    // a limit equal to the replies on file: only sent mail counts, so there is still room
    await t.db.withUser(rep, (q) => assertEmailQuota(q, before));
    await t.pool.query(
      "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'email', 'Hello there')",
      [rep, id],
    );
    await expect(t.db.withUser(rep, (q) => assertEmailQuota(q, 1))).rejects.toThrow(
      /Daily email limit/,
    );
  });
});
