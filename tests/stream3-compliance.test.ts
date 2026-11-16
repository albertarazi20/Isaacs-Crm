import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stateCompliance, type ShopRegistration, type StateRules } from "@/lib/funders/states";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;

const tx: StateRules = {
  state: "TX",
  broker_registration: true,
  registration_deadline: "2026-12-31",
  advance_fee_ban: false,
  apr_wording_rule: false,
  disclosure_law: true,
  note: "",
};
const fl: StateRules = {
  ...tx,
  state: "FL",
  broker_registration: false,
  registration_deadline: null,
  advance_fee_ban: true,
};
const registered: ShopRegistration = {
  state: "TX",
  status: "registered",
  renews_on: "2027-06-01",
  registration_no: "OCCC-1",
};

describe("S3-7 the state badge (pure)", () => {
  it("a registration state with none on file is a stop; filed is still a stop; registered is ok", () => {
    const none = stateCompliance("tx", tx, null, "2026-11-16");
    expect(none.tone).toBe("stop");
    expect(none.label).toBe("TX · not registered");
    expect(none.warnings[0]).toBe(
      "Texas requires broker registration and the shop has none on file",
    );
    expect(
      stateCompliance("TX", tx, { ...registered, status: "filed" }, "2026-11-16").warnings[0],
    ).toMatch(/filed, not yet granted/);
    const ok = stateCompliance("Texas", tx, registered, "2026-11-16");
    expect(ok.tone).toBe("watch"); // the disclosure law still wants a signature
    expect(ok.label).toBe("TX · registered");
    expect(ok.warnings).toEqual([
      "The lender's disclosure must be signed by the merchant before funding",
    ]);
  });
  it("a renewal inside 30 days is a watch, a lapsed one a stop", () => {
    expect(
      stateCompliance("TX", tx, { ...registered, renews_on: "2026-12-01" }, "2026-11-16"),
    ).toMatchObject({
      tone: "watch",
      warnings: expect.arrayContaining(["The TX registration renews on 2026-12-01"]),
    });
    expect(
      stateCompliance("TX", tx, { ...registered, renews_on: "2026-11-01" }, "2026-11-16").tone,
    ).toBe("stop");
  });
  it("Florida: no registration, but the fee rule and the disclosure law show", () => {
    const b = stateCompliance("FL", fl, null, "2026-11-16");
    expect(b.tone).toBe("watch");
    expect(b.label).toBe("FL · fee rule");
    expect(b.warnings).toEqual([
      "No fee may be collected before closing: PSF at closing or from proceeds only",
      "The lender's disclosure must be signed by the merchant before funding",
    ]);
  });
  it("no rules, no state, an unknown state", () => {
    expect(stateCompliance("OH", null, null, "2026-11-16")).toMatchObject({
      tone: "ok",
      label: "OH · no special rules",
      warnings: [],
    });
    expect(stateCompliance("", null, null, "2026-11-16")).toMatchObject({
      tone: "none",
      label: "No state on file",
    });
    expect(stateCompliance("Narnia", null, null, "2026-11-16").label).toBe("Unknown state: Narnia");
  });
});

describe("S3-7 submit to ops warns when the shop is not registered", () => {
  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  });
  afterAll(async () => {
    await t.drop();
  });

  const submit = async (name: string, state: string) => {
    const id = await insertClient(t.db, rep, name);
    await t.pool.query("update clients set state = $2 where id = $1", [id, state]);
    const d = await t.db.withUser(
      rep,
      async (q) =>
        (
          await q.query<{ id: string; blocker: string }>(
            "select id, blocker from submit_to_ops($1)",
            [id],
          )
        ).rows[0]!,
    );
    const warnings = (
      await t.pool.query<{ body: string }>(
        "select body from activities where client_id = $1 and body like 'Warning:%' order by occurred_at",
        [id],
      )
    ).rows.map((r) => r.body);
    return { id, deal: d, warnings };
  };

  it("Texas requires registration and the shop has none: a timeline warning and the blocker say so", async () => {
    const r = await submit("Austin Autos", "tx");
    expect(r.warnings).toEqual([
      "Warning: TX requires broker registration and the shop has none on file — a manager should check before this goes to lenders",
    ]);
    expect(r.deal.blocker).toBe("Shop is not registered in TX");
  });
  it("Florida has no registration rule: no warning", async () => {
    const r = await submit("Miami Marine", "FL");
    expect(r.warnings).toEqual([]);
    expect(r.deal.blocker).toBe("");
  });
  it("once the shop is registered in Texas the warning stops; a resubmit clears the old blocker", async () => {
    await t.pool.query(
      "insert into shop_registrations (state, registration_no, status, renews_on) values ('TX', 'OCCC-1', 'registered', current_date + 300)",
    );
    const r = await submit("Dallas Diner", "TX");
    expect(r.warnings).toEqual([]);
    expect(r.deal.blocker).toBe("");
    // the earlier Texas deal, kicked back and resubmitted, is now clean too
    const ops = await insertUser(t.pool, "ops@x.com");
    await t.pool.query("update app_users set role = 'ops' where id = $1", [ops]);
    const autos = (
      await t.pool.query<{ id: string }>(
        "select id from deals where blocker like 'Shop is not registered%'",
      )
    ).rows[0]!.id;
    await t.db.withUser(ops, (q) => q.query("select kick_back_deal($1, 'other', 'x')", [autos]));
    const client = (
      await t.pool.query<{ c: string }>("select client_id as c from deals where id = $1", [autos])
    ).rows[0]!.c;
    const back = await t.db.withUser(
      rep,
      async (q) =>
        (await q.query<{ blocker: string }>("select blocker from submit_to_ops($1)", [client]))
          .rows[0]!,
    );
    expect(back.blocker).toBe("");
  });
  it("a filed-but-not-granted registration still warns", async () => {
    await t.pool.query("insert into shop_registrations (state, status) values ('VA', 'filed')");
    const r = await submit("Richmond Roofing", "VA");
    expect(r.warnings).toHaveLength(1);
    expect(r.deal.blocker).toBe("Shop is not registered in VA");
  });
});
