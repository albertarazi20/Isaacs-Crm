import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listTemplates } from "@/lib/buckets/queries";
import { checkImportRows, importClients } from "@/lib/data/import";
import { createClient, updateClient } from "@/lib/data/mutations";
import {
  clientFieldsSchema,
  importCheckSchema,
  importRowSchema,
  importSchema,
  newClientSchema,
} from "@/lib/data/schemas";
import type { UserContext } from "@/lib/data/types";
import { handOff, undoHandOff } from "@/lib/followup/handoff";
import { intakeSchema } from "@/lib/leads/form";
import { leadSchema } from "@/lib/leads/schema";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The UI bug hunt fixes (db/migrations/0546_ui_fixes.sql and the code around them). Every claim is read back from the
 * database. The migration's data steps are checked by seeding the bad rows and running the migration file again
 * (it is safe to run twice), so the file itself is what is tested.
 */

let t: TestDb;
let rep: string;
let other: string;
let ctx: UserContext;
let phone = 3055551100;

const MIGRATION = readFileSync(
  join(process.cwd(), "db", "migrations", "0546_ui_fixes.sql"),
  "utf8",
);
const rerunMigration = () => t.pool.query(MIGRATION);

const merchant = (userId: string, name: string, extra: Record<string, unknown> = {}) =>
  t.db.withUser(userId, async (q) => {
    phone += 1;
    const { rows } = await q.query<{ id: string }>(
      "select id from create_client($1::jsonb, $2::jsonb)",
      [
        JSON.stringify({
          business_name: name,
          contact_name: "Owner",
          phone: String(phone),
          email: `owner${phone}@x.com`,
          state: "FL",
          ...extra,
        }),
        JSON.stringify([{ kind: "follow_up", due_on: addDays(t.today, 1) }]),
      ],
    );
    return rows[0]!.id;
  });
const bucket = async (key: string) =>
  (await t.pool.query<{ id: string }>("select id from buckets where key = $1", [key])).rows[0]!.id;
const enrol = (id: string, key: string) =>
  bucket(key).then((b) =>
    t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [id, b])),
  );
const live = async (id: string) =>
  (
    await t.pool.query<{
      key: string;
      next_step: number;
      steps_sent: number;
      next_due_on: string | null;
      entered_at: Date;
      paused: boolean;
    }>(
      `select b.key, e.next_step, e.steps_sent, e.next_due_on::text as next_due_on, e.entered_at, e.paused
         from enrollments e join buckets b on b.id = e.bucket_id
        where e.client_id = $1 and e.stopped_at is null`,
      [id],
    )
  ).rows;
const openFollowUps = async (id: string) =>
  (
    await t.pool.query<{ due_on: string }>(
      "select due_on::text as due_on from timers where client_id = $1 and done_at is null and kind = 'follow_up'",
      [id],
    )
  ).rows;
const localToday = async (id: string) =>
  (
    await t.pool.query<{ d: string }>(
      "select (now() at time zone app.client_timezone(c))::date::text as d from clients c where c.id = $1",
      [id],
    )
  ).rows[0]!.d;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com");
  other = await insertUser(t.pool, "other@x.com");
  ctx = { today: t.today, timezone: "UTC" };
});
afterAll(async () => {
  await t.drop();
});

describe("1: the Renewal templates are archived and never offered", () => {
  it("every shop template named Renewal… is archived; listTemplates (the Blast list and the step pickers) leaves them out", async () => {
    const seeded = await t.pool.query<{ name: string; archived: boolean }>(
      "select name, archived from templates where owner_id is null and name like 'Renewal%' order by name",
    );
    expect(seeded.rows).toEqual([
      { name: "Renewal — eligible", archived: true },
      { name: "Renewal — warm-up", archived: true },
    ]);

    // a shop template put back by hand is archived again by the migration; a rep's own "Renewal" template is theirs
    await t.pool.query("update templates set archived = false where name = 'Renewal — eligible'");
    await t.pool.query(
      "insert into templates (owner_id, name, subject, body, approved) values ($1, 'Renewal notes', 'Hi', 'Checking in', true)",
      [rep],
    );
    await rerunMigration();
    const after = await t.pool.query<{ name: string; owner: boolean; archived: boolean }>(
      "select name, owner_id is not null as owner, archived from templates where name like 'Renewal%' order by name",
    );
    expect(after.rows).toEqual([
      { name: "Renewal notes", owner: true, archived: false },
      { name: "Renewal — eligible", owner: false, archived: true },
      { name: "Renewal — warm-up", owner: false, archived: true },
    ]);

    const offered = await t.db.withUser(rep, (q) => listTemplates(q));
    expect(offered.filter((x) => x.name.startsWith("Renewal —"))).toEqual([]);
    expect(offered.every((x) => !x.archived)).toBe(true);
    expect(offered.map((x) => x.name)).toContain("Renewal notes");
    // the settings list (which can restore a template) still shows them, marked archived
    const all = await t.db.withUser(rep, (q) => listTemplates(q, true));
    expect(all.filter((x) => x.name.startsWith("Renewal —")).map((x) => x.archived)).toEqual([
      true,
      true,
    ]);
    // and the engine will not send one
    const may = await t.pool.query<{ may: boolean }>(
      "select bool_or(app.template_may_auto_send(id)) as may from templates where owner_id is null and name like 'Renewal%'",
    );
    expect(may.rows[0]!.may).toBe(false);
  });
});

describe("1: the alert badge counts only what the app still writes", () => {
  it("unread alerts of the removed features are marked read and never emailed; live kinds are untouched", async () => {
    const id = await merchant(rep, "Alerting Co");
    const removed = [
      "approval_landed",
      "stale_deal",
      "kickback",
      "late_payout",
      "registration",
      "trust",
      "approval_expired",
      "funding_proposed",
      "ask_manager",
    ];
    const kept = ["application_signed", "file_complete", "brought_in", "bounce_spike"];
    for (const kind of [...removed, ...kept])
      await t.pool.query(
        "insert into user_alerts (user_id, kind, client_id, title, created_at) values ($1, $2, $3, $4, now() - interval '3 days')",
        [rep, kind, id, `A ${kind} alert`],
      );
    const unread = () =>
      t.db.withUser(
        rep,
        async (q) =>
          (
            await q.query<{ n: number }>(
              "select count(*)::int as n from user_alerts where user_id = app.current_user_id() and read_at is null",
            )
          ).rows[0]!.n,
      );
    expect(await unread()).toBe(removed.length + kept.length);

    await rerunMigration();

    expect(await unread()).toBe(kept.length);
    const rows = await t.pool.query<{ kind: string; read: boolean; emailed: boolean }>(
      "select kind, read_at is not null as read, emailed_at is not null as emailed from user_alerts where user_id = $1 order by kind",
      [rep],
    );
    for (const r of rows.rows) {
      const gone = removed.includes(r.kind);
      expect({ kind: r.kind, read: r.read, emailed: r.emailed }).toEqual({
        kind: r.kind,
        read: gone,
        emailed: gone,
      });
    }
  });
});

describe("2: undo puts the merchant back in the bucket the hand-off stopped", () => {
  it("re-opens the same bucket at the same next step, on the same day, with no stand-in follow-up", async () => {
    const id = await merchant(rep, "Same Step Co");
    await enrol(id, "missing_statements");
    const due = addDays(t.today, 4);
    await t.pool.query(
      "update enrollments set next_step = 3, steps_sent = 2, next_due_on = $2, entered_at = now() - interval '6 days' where client_id = $1 and stopped_at is null",
      [id, due],
    );
    const before = (await live(id))[0]!;
    await t.db.withUser(rep, (q) => handOff(q, id));
    expect(await live(id)).toEqual([]);

    const r = await t.db.withUser(rep, (q) => undoHandOff(q, id));
    expect(r.bucket).toBe("Missing statements");
    expect(await live(id)).toEqual([
      {
        key: "missing_statements",
        next_step: 3,
        steps_sent: 2,
        next_due_on: due,
        entered_at: before.entered_at,
        paused: false,
      },
    ]);
    expect(await openFollowUps(id)).toEqual([]);
    const brought = await t.pool.query<{ at: Date | null }>(
      "select brought_in_at as at from clients where id = $1",
      [id],
    );
    expect(brought.rows[0]!.at).toBeNull();
  });

  it("a step that fell due during the hand-off is due today, not in the past", async () => {
    const id = await merchant(rep, "Late Step Co");
    await enrol(id, "interested");
    await t.pool.query(
      "update enrollments set next_step = 2, next_due_on = current_date - 3 where client_id = $1 and stopped_at is null",
      [id],
    );
    await t.db.withUser(rep, (q) => handOff(q, id));
    await t.db.withUser(rep, (q) => undoHandOff(q, id));
    expect(await live(id)).toMatchObject([
      { key: "interested", next_step: 2, next_due_on: await localToday(id) },
    ]);
  });

  it("goes back to the bucket of the latest hand-off, not an older one", async () => {
    const id = await merchant(rep, "Twice Co");
    await enrol(id, "interested");
    await t.db.withUser(rep, (q) => handOff(q, id));
    await t.db.withUser(rep, (q) => undoHandOff(q, id));
    await enrol(id, "missing_id");
    await t.db.withUser(rep, (q) => handOff(q, id));
    expect((await t.db.withUser(rep, (q) => undoHandOff(q, id))).bucket).toBe(
      "Missing ID / voided check",
    );
    expect((await live(id)).map((e) => e.key)).toEqual(["missing_id"]);

    // taken out of the bucket by hand before the next hand-off: there is no bucket to re-open this time
    await t.db.withUser(rep, (q) => q.query("select stop_enrollment($1, 'removed')", [id]));
    await t.db.withUser(rep, (q) => handOff(q, id));
    expect((await t.db.withUser(rep, (q) => undoHandOff(q, id))).bucket).toBeNull();
    expect(await live(id)).toEqual([]);
    expect(await openFollowUps(id)).toEqual([{ due_on: addDays(t.today, 1) }]);
  });

  it("a bucket switched off meanwhile, or a merchant who opted out meanwhile, gets the follow-up for tomorrow instead", async () => {
    const off = await merchant(rep, "Bucket Gone Co");
    await enrol(off, "missing_app");
    await t.db.withUser(rep, (q) => handOff(q, off));
    await t.pool.query("update buckets set active = false where key = 'missing_app'");
    try {
      expect((await t.db.withUser(rep, (q) => undoHandOff(q, off))).bucket).toBeNull();
    } finally {
      await t.pool.query("update buckets set active = true where key = 'missing_app'");
    }
    expect(await live(off)).toEqual([]);
    expect(await openFollowUps(off)).toEqual([{ due_on: addDays(t.today, 1) }]);

    const opted = await merchant(rep, "Opted Out Co");
    await enrol(opted, "interested");
    await t.db.withUser(rep, (q) => handOff(q, opted));
    await t.pool.query("update clients set email_opt_out = true where id = $1", [opted]);
    expect((await t.db.withUser(rep, (q) => undoHandOff(q, opted))).bucket).toBeNull();
    expect(await live(opted)).toEqual([]);
    expect(await openFollowUps(opted)).toEqual([{ due_on: addDays(t.today, 1) }]);
  });

  it("another rep still cannot undo it, and the function keeps its definer settings", async () => {
    const id = await merchant(rep, "Guarded Co");
    await enrol(id, "interested");
    await t.db.withUser(rep, (q) => handOff(q, id));
    await expect(t.db.withUser(other, (q) => undoHandOff(q, id))).rejects.toThrow(
      /not on your list/,
    );
    expect(await live(id)).toEqual([]);
    const fn = await t.pool.query<{ prosecdef: boolean; proconfig: string[]; app: boolean }>(
      `select p.prosecdef, p.proconfig, has_function_privilege('isaac_app', p.oid, 'execute') as app
         from pg_proc p where p.proname = 'undo_hand_off'`,
    );
    expect(fn.rows[0]).toMatchObject({ prosecdef: true, app: true });
    expect(fn.rows[0]!.proconfig.join(",")).toMatch(/search_path=public, pg_temp/);
  });
});

describe("3: the import review counts what the import will really do", () => {
  it("reports rows already in the person's own CRM and do-not-contact ones, judged like importClients", async () => {
    const mine = await merchant(rep, "Already Mine Co");
    const minePhone = (
      await t.pool.query<{ phone: string }>("select phone from clients where id = $1", [mine])
    ).rows[0]!.phone;
    const held = await merchant(rep, "Do Not Call Co");
    const heldPhone = (
      await t.pool.query<{ phone: string }>("select phone from clients where id = $1", [held])
    ).rows[0]!.phone;
    await t.pool.query("update clients set contact_status = 'dnc' where id = $1", [held]);
    await t.db.withUser(rep, (q) => q.query("select trash_client($1)", [held]));
    const theirs = await merchant(other, "Someone Elses Co");
    const theirPhone = (
      await t.pool.query<{ phone: string }>("select phone from clients where id = $1", [theirs])
    ).rows[0]!.phone;
    await merchant(rep, "Name Only Co", { phone: "" });

    const rows = importCheckSchema.parse({
      rows: [
        { line: 2, phone: minePhone.replace("+1", ""), businessName: "Already Mine Co" },
        { line: 3, phone: heldPhone, businessName: "Do Not Call Co" },
        { line: 4, phone: theirPhone, businessName: "Someone Elses Co" },
        { line: 5, phone: "3055559999", businessName: "Brand New Co" },
        { line: 6, phone: "", businessName: "name only co" },
        { line: 7, phone: "", businessName: "No Phone New Co" },
        { line: 8, phone: "", businessName: "No Phone New Co" },
      ],
    }).rows;
    const check = await t.db.withUser(rep, (q) => checkImportRows(q, rows));
    // another rep's merchant is not visible under row security: it is not "already in your CRM"
    expect(check).toEqual({ existing: [2, 6, 8], doNotContact: [3] });
    // (line 8 repeats line 7's name with no phone: the import would skip it once line 7 lands, for anyone)
    expect(await t.db.withUser(other, (q) => checkImportRows(q, rows))).toEqual({
      existing: [4, 8],
      doNotContact: [],
    });

    // the import agrees with the review: the same rows are skipped
    const full = (line: number, businessName: string, p: string) =>
      importRowSchema.parse({
        line,
        businessName,
        phone: p,
        email: "",
        stage: "name_in",
        followUpOn: addDays(t.today, 1),
      });
    const result = await t.db.withUser(rep, async (q) =>
      importClients(
        q,
        importSchema.parse({
          rows: rows.filter((r) => r.line !== 4).map((r) => full(r.line, r.businessName, r.phone)),
        }).rows,
        ctx,
      ),
    );
    expect(result).toMatchObject({
      created: 2,
      skippedExisting: check.existing.length,
      skippedDoNotContact: check.doNotContact.length,
      failed: [],
    });
  });
});

describe("5: a state is saved trimmed and in capitals", () => {
  it("every schema that takes a state stores it in capitals", async () => {
    expect(newClientSchema.parse({ businessName: "A", state: " ny " }).state).toBe("NY");
    expect(clientFieldsSchema.parse({ state: "ca" }).state).toBe("CA");
    expect(
      importRowSchema.parse({
        line: 2,
        businessName: "A",
        state: "tx",
        stage: "name_in",
        followUpOn: t.today,
      }).state,
    ).toBe("TX");
    expect(intakeSchema.parse({ phone: "3055550000", state: " fl" }).state).toBe("FL");
    expect(leadSchema.parse({ phone: "3055550000", businessName: "A", state: " nj " }).state).toBe(
      "NJ",
    );
    expect(leadSchema.parse({ phone: "3055550000", businessName: "A" }).state).toBeUndefined();

    const card = await t.db.withUser(rep, (q) =>
      createClient(
        q,
        newClientSchema.parse({ businessName: "Lower State Co", phone: "3055558888", state: "ny" }),
        ctx,
      ),
    );
    await t.db.withUser(rep, (q) =>
      updateClient(q, { clientId: card.id, fields: clientFieldsSchema.parse({ state: " ga " }) }),
    );
    const saved = await t.pool.query<{ state: string }>("select state from clients where id = $1", [
      card.id,
    ]);
    expect(saved.rows[0]!.state).toBe("GA");
  });

  it("the migration puts the two-letter states already saved in capitals, and leaves other text alone", async () => {
    const ids = {
      lower: await merchant(rep, "State Lower Co", { state: "ny" }),
      padded: await merchant(rep, "State Padded Co", { state: " fl " }),
      word: await merchant(rep, "State Word Co", { state: "Florida" }),
      upper: await merchant(rep, "State Upper Co", { state: "TX" }),
    };
    await rerunMigration();
    const got = await t.pool.query<{ id: string; state: string }>(
      "select id, state from clients where id = any($1::uuid[])",
      [Object.values(ids)],
    );
    const by = new Map(got.rows.map((r) => [r.id, r.state]));
    expect(by.get(ids.lower)).toBe("NY");
    expect(by.get(ids.padded)).toBe("FL");
    expect(by.get(ids.word)).toBe("Florida");
    expect(by.get(ids.upper)).toBe("TX");
  });
});
