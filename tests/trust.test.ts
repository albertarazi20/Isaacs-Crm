import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accessHistory,
  createCanary,
  exposureReport,
  listTeam,
  logAccess,
  offboardUser,
  trustPanel,
  trustScore,
} from "@/lib/trust/queries";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

describe("trust score", () => {
  const zero = {
    user_id: "",
    name: "",
    email: "",
    role: "rep",
    active: true,
    contact_copies: 0,
    contact_views: 0,
    exports: 0,
    document_opens: 0,
    after_hours_opens: 0,
    contact_changes: 0,
    dead_after_approval: 0,
    canaries_touched: 0,
    mass_views: 0,
  };
  it("a busy rep is calm; a canary touch or a contact change is not", () => {
    expect(trustScore({ ...zero, contact_copies: 35, document_opens: 50 }).tone).toBe("calm");
    expect(trustScore({ ...zero, contact_changes: 2 }).tone).toBe("watch");
    expect(trustScore({ ...zero, canaries_touched: 1 }).tone).toBe("look");
    expect(trustScore({ ...zero, exports: 3, dead_after_approval: 2 }).tone).toBe("look");
  });
});

describe("the access log, canaries, team and offboarding", () => {
  let t: TestDb;
  let rep: string;
  let rep2: string;
  let manager: string;
  let pizza: string;
  let pearl: string;

  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    rep2 = await insertUser(t.pool, "rep2@x.com", "America/New_York");
    manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
    await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
      manager,
    ]);
    await t.pool.query("update app_users set name = 'Josh' where id = $1", [rep]);
    await t.pool.query("update app_users set name = 'Sam' where id = $1", [rep2]);
    pizza = await insertClient(t.db, rep, "Pizza Palace");
    await t.pool.query(
      "update clients set email = 'mike@pizza.com', phone = '5551234567' where id = $1",
      [pizza],
    );
    pearl = (
      await t.pool.query<{ id: string }>(
        "insert into funders (user_id, name, submission_email) values ($1, 'Pearl', 's@p.com') returning id",
        [manager],
      )
    ).rows[0]!.id;
  });
  afterAll(async () => {
    await t.drop();
  });

  it("a rep writes their own lines and cannot read the log; a manager reads everyone's", async () => {
    await t.db.withUser(rep, (q) =>
      logAccess(q, { userId: rep, action: "copy_phone", clientId: pizza, detail: "5551234567" }),
    );
    await t.db.withUser(rep, (q) =>
      logAccess(q, { userId: rep, action: "view_contact", clientId: pizza }),
    );
    await expect(
      t.db.withUser(rep, (q) =>
        logAccess(q, { userId: rep2, action: "copy_phone", clientId: pizza }),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await t.db.withUser(rep, (q) => accessHistory(q, rep))).toEqual([]);
    const mine = await t.db.withUser(manager, (q) => accessHistory(q, rep));
    expect(mine.map((l) => l.action)).toEqual(["view_contact", "copy_phone"]);
    expect(mine[1]?.business_name).toBe("Pizza Palace");
  });

  it("a contact change on a file that is with lenders is logged; on a fresh lead it is not", async () => {
    await t.db.withUser(rep, (q) =>
      q.query("update clients set phone = '5550000001' where id = $1", [pizza]),
    );
    let hist = await t.db.withUser(manager, (q) => accessHistory(q, rep));
    expect(hist.some((l) => l.action === "contact_changed")).toBe(false);
    await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [pizza]));
    await t.pool.query(
      "update deals set ops_status = 'sent', sent_at = now() where client_id = $1",
      [pizza],
    );
    await t.pool.query(
      "insert into submissions (user_id, client_id, funder_id, sent_on, status) values ($1, $2, $3, current_date, 'sent')",
      [rep, pizza, pearl],
    );
    await t.db.withUser(rep, (q) =>
      q.query("update clients set phone = '5559999999', email = 'other@gmail.com' where id = $1", [
        pizza,
      ]),
    );
    hist = await t.db.withUser(manager, (q) => accessHistory(q, rep));
    const change = hist.find((l) => l.action === "contact_changed");
    expect(change?.detail).toBe(
      "phone: 5550000001 → 5559999999; email: mike@pizza.com → other@gmail.com",
    );
    const panel = await t.db.withUser(manager, (q) => trustPanel(q));
    const josh = panel.find((r) => r.email === "rep@x.com");
    expect(josh).toMatchObject({
      contact_copies: 1,
      contact_views: 1,
      contact_changes: 1,
      tone: "calm",
    });
  });

  it("the leak tracer lists every person and lender who had the file", async () => {
    const x = await t.db.withUser(manager, (q) => exposureReport(q, pizza));
    expect(x.business_name).toBe("Pizza Palace");
    expect(x.people.map((p) => [p.name, p.actions, p.copies, p.owner])).toEqual([
      ["Josh", 3, 1, true],
    ]);
    expect(x.lenders.map((l) => l.name)).toEqual(["Pearl"]);
    await expect(t.db.withUser(rep, (q) => exposureReport(q, pizza))).resolves.toMatchObject({
      people: [],
    }); // the log is hidden from reps
  });

  it("managers add people and change roles; reps cannot; nobody demotes themselves", async () => {
    const added = await t.db.withUser(manager, (q) =>
      q.query<{ id: string; role: string }>(
        "select * from add_team_member('Ops.One@SelectiveCap.com', 'Ops One', 'ops')",
      ),
    );
    expect(added.rows[0]?.role).toBe("ops");
    const team = await t.db.withUser(manager, (q) => listTeam(q));
    expect(team.find((m) => m.email === "ops.one@selectivecap.com")).toMatchObject({
      role: "ops",
      active: true,
      clients: 0,
    });
    await expect(
      t.db.withUser(rep, (q) => q.query("select add_team_member('x@y.com', 'X', 'rep')")),
    ).rejects.toThrow(/only a manager/);
    await expect(
      t.db.withUser(manager, (q) => q.query("select set_team_member($1, 'rep', true)", [manager])),
    ).rejects.toThrow(/yourself/);
    await t.db.withUser(manager, (q) =>
      q.query("select set_team_member($1, 'rep', false)", [added.rows[0]!.id]),
    );
    expect(
      (
        await t.pool.query<{ active: boolean; session_epoch: number }>(
          "select active, session_epoch from app_users where id = $1",
          [added.rows[0]!.id],
        )
      ).rows[0],
    ).toEqual({ active: false, session_epoch: 1 });
    expect(
      (await t.db.withUser(manager, (q) => accessHistory(q, manager))).filter(
        (l) => l.action === "team_change",
      ),
    ).toHaveLength(2);
  });

  it("a canary sits in the rep's book and shows up on the tracer", async () => {
    const canary = await t.db.withUser(manager, (q) =>
      createCanary(q, {
        repId: rep,
        business: "Harbor Deli",
        contact: "Al",
        phone: "5551112222",
        email: "al@harbordeli.com",
      }),
    );
    const row = (
      await t.pool.query<{ is_canary: boolean; user_id: string }>(
        "select is_canary, user_id from clients where id = $1",
        [canary],
      )
    ).rows[0];
    expect(row).toEqual({ is_canary: true, user_id: rep });
    await t.db.withUser(rep, (q) =>
      logAccess(q, { userId: rep, action: "copy_phone", clientId: canary }),
    );
    const panel = await t.db.withUser(manager, (q) => trustPanel(q));
    expect(panel.find((r) => r.email === "rep@x.com")).toMatchObject({
      canaries_touched: 1,
      tone: "look",
    });
    await expect(
      t.db.withUser(rep, (q) =>
        createCanary(q, {
          repId: rep2,
          business: "X",
          contact: "",
          phone: "5550001111",
          email: "x@y.com",
        }),
      ),
    ).rejects.toThrow(/only a manager/);
  });

  it("offboarding kills the login, cuts the mailbox, moves the whole book and reports the 30 days", async () => {
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc) values ($1, 'rep@x.com', 'enc')",
      [rep],
    );
    await t.pool.query(
      "insert into mailboxes (kind, user_id, address) values ('gmail', $1, 'rep@x.com')",
      [rep],
    );
    const bucket = (
      await t.pool.query<{ id: string }>("select id from buckets where key = 'missing_statements'")
    ).rows[0]!.id;
    await t.pool.query("select enroll_in_bucket($1, $2, 'moved')", [pizza, bucket]);
    const before = (
      await t.pool.query<{ e: number }>("select session_epoch as e from app_users where id = $1", [
        rep,
      ])
    ).rows[0]!.e;

    await expect(t.db.withUser(rep2, (q) => offboardUser(q, rep, rep2))).rejects.toThrow(
      /only a manager/,
    );
    const report = await t.db.withUser(manager, (q) => offboardUser(q, rep, rep2));
    expect(report).toMatchObject({
      user: "rep@x.com",
      to: "rep2@x.com",
      clients_moved: 2,
      deals_moved: 1,
      enrollments_moved: 1,
    });
    expect(report.last_30_days).toMatchObject({
      contact_copies: 2,
      contact_views: 1,
      contact_changes: 1,
      canaries_touched: 1,
      lenders_sent_to: 1,
    });

    const u = (
      await t.pool.query<{ active: boolean; session_epoch: number; offboarded_at: string | null }>(
        "select active, session_epoch, offboarded_at::text from app_users where id = $1",
        [rep],
      )
    ).rows[0]!;
    expect(u.active).toBe(false);
    expect(u.session_epoch).toBe(before + 1);
    expect(u.offboarded_at).not.toBeNull();
    expect(
      (await t.pool.query("select 1 from gmail_connections where user_id = $1", [rep])).rowCount,
    ).toBe(0);
    expect(
      (
        await t.pool.query<{ active: boolean }>("select active from mailboxes where user_id = $1", [
          rep,
        ])
      ).rows[0]?.active,
    ).toBe(false);
    // the book is Sam's now, children included, and every merchant says so
    expect(
      (
        await t.pool.query<{ n: number }>(
          "select count(*)::int as n from clients where user_id = $1",
          [rep],
        )
      ).rows[0]?.n,
    ).toBe(0);
    for (const table of [
      "clients",
      "timers",
      "activities",
      "deals",
      "submissions",
      "enrollments",
      "stips",
    ]) {
      const bad = await t.pool.query<{ n: number }>(
        `select count(*)::int as n from ${table} where user_id = $1`,
        [rep],
      );
      expect([table, bad.rows[0]?.n]).toEqual([table, 0]);
    }
    const sam = await t.db.withUser(rep2, (q) =>
      q.query<{ business_name: string }>(
        "select business_name from clients order by business_name",
      ),
    );
    expect(sam.rows.map((r) => r.business_name)).toEqual(["Harbor Deli", "Pizza Palace"]);
    const note = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 order by occurred_at desc limit 1",
      [pizza],
    );
    expect(note.rows[0]?.body).toBe("Reassigned from Josh to Sam (offboarding)");
    // the manager's own log has the report
    expect(
      (await t.db.withUser(manager, (q) => accessHistory(q, manager))).some(
        (l) => l.action === "offboard",
      ),
    ).toBe(true);
    // a disabled person is not a login
    expect(
      (await t.pool.query("select 1 from app_users where id = $1 and active", [rep])).rowCount,
    ).toBe(0);
  });
});
