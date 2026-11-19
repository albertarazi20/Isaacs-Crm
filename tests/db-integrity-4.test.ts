import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let boss: string;
let other: string;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "UTC");
  boss = await insertUser(t.pool, "boss@x.com", "UTC");
  other = await insertUser(t.pool, "other@x.com", "UTC");
  await t.pool.query("update app_users set role = 'manager' where id = $1", [boss]);
});
afterAll(async () => {
  await t.drop();
});

const q1 = (sql: string, params: unknown[] = []) => t.pool.query(sql, params);
const num = async (sql: string, params: unknown[] = []) =>
  Number((await t.pool.query<{ n: string }>(sql, params)).rows[0]?.n);
const merge = (keep: string, drop: string, as = rep) =>
  t.db.withUser(as, (q) => q.query("select * from merge_clients($1, $2)", [keep, drop]));
const sha = (c: string) => c.repeat(64);

async function bucketId(key: string): Promise<string> {
  return (await q1("select id from buckets where key = $1", [key])).rows[0]?.id as string;
}
async function doc(client: string, hash: string, key: string, filename = "f.pdf") {
  const r = await q1(
    `insert into documents (user_id, client_id, kind, filename, content_type, size_bytes, sha256, storage_key, source)
     values ($1, $2, 'other', $3, 'application/pdf', 10, $4, $5, 'staff') returning id`,
    [rep, client, filename, hash, key],
  );
  return r.rows[0]?.id as string;
}

describe("database-1: merging two cards keeps everything that hangs off the other card", () => {
  it("moves a row of every table that references clients, and resolves the clashes", async () => {
    const keep = await insertClient(t.db, rep, "Keep Co");
    const drop = await insertClient(t.db, rep, "Drop Co");

    // documents: one only the dropped card has, one the kept card also has (same bytes)
    await doc(drop, sha("a"), "k/drop-only", "only.pdf");
    const dupDrop = await doc(drop, sha("b"), "k/dup-drop", "dup.pdf");
    const dupKeep = await doc(keep, sha("b"), "k/dup-keep", "dup.pdf");
    // the signed application points at the duplicate on the dropped card
    await q1(
      "insert into applications (client_id, user_id, fields, signer_name, document_id) values ($1, $2, '{}', 'Mike', $3)",
      [drop, rep, dupDrop],
    );
    // follow-up enrolment on both cards
    await q1("select enroll_in_bucket($1, $2, 'moved')", [keep, await bucketId("cold")]);
    await q1("select enroll_in_bucket($1, $2, 'moved')", [drop, await bucketId("interested")]);
    // mail: one clashing sequence copy, one plain
    await q1(
      `insert into outbox (user_id, client_id, lane, source, to_address, subject, text_body, status)
       values ($1, $2, 'sequence', 'clash-1', 'm@x.com', 's', 'b', 'queued'),
              ($1, $3, 'sequence', 'clash-1', 'm@x.com', 's', 'b', 'queued'),
              ($1, $3, 'system', 'sys-1', 'm@x.com', 's', 'b', 'sent')`,
      [rep, keep, drop],
    );
    // approvals: an open one on each card; the dropped card's queued email must not survive
    await q1("insert into approvals (client_id, user_id, amount_cents) values ($1, $2, 5000000)", [
      keep,
      rep,
    ]);
    const apDrop = (
      await q1(
        "insert into approvals (client_id, user_id, amount_cents) values ($1, $2, 7000000) returning id",
        [drop, rep],
      )
    ).rows[0]?.id as string;
    await q1(
      `insert into outbox (user_id, client_id, lane, source, to_address, subject, text_body, status)
       values ($1, $2, 'approval', $3, 'm@x.com', 's', 'b', 'queued')`,
      [rep, drop, `approval:${apDrop}:step:1`],
    );
    await q1(
      `insert into merchant_offers (client_id, user_id, token, funded_cents, factor_rate, frequency, payments, expires_at)
       values ($1, $2, 'tok-offer', 5000000, 1.3, 'daily', 100, now() + interval '3 days')`,
      [drop, rep],
    );
    await q1(
      "insert into upload_sessions (token, client_id, expires_at) values ('tok-up', $1, now() + interval '1 day')",
      [drop],
    );
    await q1("insert into link_opens (client_id, kind) values ($1, 'upload')", [drop]);
    const email = (
      await q1(
        "insert into inbound_emails (gmail_id, received_at, client_id) values ('g1', now(), $1) returning id",
        [drop],
      )
    ).rows[0]?.id as string;
    await q1(
      "insert into reply_tags (email_id, client_id, tag, confidence) values ($1, $2, 'other', 0.5)",
      [email, drop],
    );
    await q1(
      "insert into brain_preps (user_id, client_id, kind, trigger_key) values ($1, $2, 'plan', 'trig-1')",
      [rep, drop],
    );
    await q1(
      "insert into user_alerts (user_id, kind, title, client_id) values ($1, 'x', 'T', $2)",
      [rep, drop],
    );
    const mailbox = (
      await q1("insert into mailboxes (kind, address) values ('resend', 'a@x.com') returning id")
    ).rows[0]?.id as string;
    await q1("insert into send_ledger (mailbox_id, lane, client_id) values ($1, 'sequence', $2)", [
      mailbox,
      drop,
    ]);
    await q1(
      "insert into suppressions (channel, key_hash, reason, client_id) values ('email', 'h1', 'unsubscribe', $1)",
      [drop],
    );
    const source = (
      await q1("insert into sheet_sources (name, spreadsheet_id) values ('s', 'sid') returning id")
    ).rows[0]?.id as string;
    await q1(
      "insert into sheet_rows (source_id, row_no, row_hash, client_id) values ($1, 1, 'rh', $2)",
      [source, drop],
    );
    const auditId = (
      await q1(
        "insert into access_log (user_id, action, client_id) values ($1, 'view_contact', $2) returning id",
        [rep, drop],
      )
    ).rows[0]?.id as string;
    await q1("insert into backdoor_reports (client_id) values ($1)", [drop]);
    await q1(
      "insert into winback_members (user_id, client_id, pool, workable_on) values ($1, $2, 'declined_curable', current_date), ($1, $3, 'declined_curable', current_date)",
      [rep, keep, drop],
    );
    // a deal last (a submitted deal stops the card's live enrolment) with its rescue nudge
    const deal = (
      await q1("insert into deals (user_id, client_id) values ($1, $2) returning id", [rep, drop])
    ).rows[0]?.id as string;
    await q1(
      "insert into rescue_nudges (deal_id, user_id, client_id, day) values ($1, $2, $3, 20)",
      [deal, rep, drop],
    );

    // every table that references clients had a row on the dropped card (a new table has to be added here)
    const refs = (
      await q1(
        `select distinct c.conrelid::regclass::text as tbl from pg_constraint c
          where c.contype = 'f' and c.confrelid = 'public.clients'::regclass order by 1`,
      )
    ).rows.map((r) => r.tbl as string);
    const SKIP_BEFORE = new Set([
      "trashed_clients",
      "timers",
      "submissions",
      "offers",
      "stips",
      "client_asks",
      "positions",
      "competing_offers",
      "fundings",
      // 0583: gets its rows from the merge itself (the dropped card's links, pointed at the kept card); proved in
      // review-fixes-merge-sync-claims.test.ts
      "client_token_aliases",
    ]); // the first and the last four are covered by merge.test.ts
    // access_log is an append-only audit trail: merge_clients deliberately does not rewrite it (checked after the merge)
    const AUDIT = "access_log";
    for (const tbl of refs) {
      if (SKIP_BEFORE.has(tbl)) continue;
      const n = await num(`select count(*) n from ${tbl} where client_id = $1`, [drop]);
      expect(n, `fixture for ${tbl}`).toBeGreaterThan(0);
    }
    const before: Record<string, number> = {};
    for (const tbl of refs) {
      before[tbl] = await num(`select count(*) n from ${tbl} where client_id = $1`, [drop]);
    }

    await merge(keep, drop);

    expect(await num("select count(*) n from clients where id = $1", [drop])).toBe(0);
    // nothing is left behind for the dropped card and the rows now belong to the kept card
    for (const tbl of refs) {
      if (SKIP_BEFORE.has(tbl) || tbl === "backdoor_reports" || tbl === AUDIT) continue;
      const left = await num(`select count(*) n from ${tbl} where client_id = $1`, [drop]);
      expect(left, `${tbl} rows left on the dropped card`).toBe(0);
      const kept = await num(`select count(*) n from ${tbl} where client_id = $1`, [keep]);
      expect(kept, `${tbl} rows on the kept card`).toBeGreaterThanOrEqual(before[tbl] ?? 0);
    }

    // the audit trail is not re-pointed: its row survives as it was, only the foreign key (on delete set null) lets go
    // of the dropped card; no row of it was moved to the kept card
    const audit = (
      await q1("select user_id, action, client_id, detail from access_log where id = $1", [auditId])
    ).rows[0];
    expect(audit).toMatchObject({ user_id: rep, action: "view_contact", client_id: null });
    expect(await num("select count(*) n from access_log where client_id = $1", [keep])).toBe(0);

    // documents: the only-file moved, the duplicate is not a second live copy, and the application follows the kept copy
    expect(
      await num(
        "select count(*) n from documents where client_id = $1 and storage_key = 'k/drop-only' and deleted_at is null",
        [keep],
      ),
    ).toBe(1);
    expect(
      await num(
        "select count(*) n from documents where client_id = $1 and sha256 = $2 and deleted_at is null",
        [keep, sha("b")],
      ),
    ).toBe(1);
    expect(
      await num(
        "select count(*) n from documents where storage_key = 'k/dup-drop' and client_id = $1 and deleted_at is not null",
        [keep],
      ),
    ).toBe(1);
    expect(
      (await q1("select document_id from applications where client_id = $1", [keep])).rows[0]
        ?.document_id,
    ).toBe(dupKeep);
    // one live enrolment: the kept card's; the other's history came along, stopped
    expect(
      await num("select count(*) n from enrollments where client_id = $1 and stopped_at is null", [
        keep,
      ]),
    ).toBe(1);
    expect(
      await num(
        "select count(*) n from enrollments e join buckets b on b.id = e.bucket_id where e.client_id = $1 and e.stopped_at is null and b.key = 'cold'",
        [keep],
      ),
    ).toBe(1);
    // mail: the clashing copy was cancelled, the plain row moved
    expect(
      await num(
        "select count(*) n from outbox where client_id = $1 and source = 'clash-1' and status = 'queued'",
        [keep],
      ),
    ).toBe(1);
    expect(
      await num(
        "select count(*) n from outbox where client_id = $1 and source = 'clash-1' and status = 'cancelled'",
        [keep],
      ),
    ).toBe(1);
    expect(
      await num(
        "select count(*) n from outbox where client_id = $1 and source = 'sys-1' and status = 'sent'",
        [keep],
      ),
    ).toBe(1);
    // approvals: still exactly one open one (the kept card's); the other is closed, its email cancelled
    expect(
      await num(
        "select count(*) n from approvals where client_id = $1 and status = 'open' and amount_cents = 5000000",
        [keep],
      ),
    ).toBe(1);
    expect(
      await num(
        "select count(*) n from approvals where client_id = $1 and status = 'closed' and id = $2",
        [keep, apDrop],
      ),
    ).toBe(1);
    expect(
      await num("select count(*) n from outbox where source = $1 and status = 'cancelled'", [
        `approval:${apDrop}:step:1`,
      ]),
    ).toBe(1);
    // winback: one live row per pool
    expect(
      await num(
        "select count(*) n from winback_members where client_id = $1 and status in ('waiting','active')",
        [keep],
      ),
    ).toBe(1);
  });

  it("a live enrolment on the dropped card moves when the kept card has none", async () => {
    const keep = await insertClient(t.db, rep, "Keep Two");
    const drop = await insertClient(t.db, rep, "Drop Two");
    await q1("select enroll_in_bucket($1, $2, 'moved')", [drop, await bucketId("interested")]);
    await merge(keep, drop);
    expect(
      await num("select count(*) n from enrollments where client_id = $1 and stopped_at is null", [
        keep,
      ]),
    ).toBe(1);
  });

  it("an email opt-out on the dropped card holds for the merged card", async () => {
    const keep = await insertClient(t.db, rep, "Keep Three");
    const drop = await insertClient(t.db, rep, "Drop Three");
    await q1("select enroll_in_bucket($1, $2, 'moved')", [drop, await bucketId("interested")]);
    await q1("update clients set email_opt_out = true where id = $1", [drop]);
    await merge(keep, drop);
    const row = (await q1("select email_opt_out from clients where id = $1", [keep])).rows[0];
    expect(row?.email_opt_out).toBe(true);
    expect(
      await num("select count(*) n from enrollments where client_id = $1 and stopped_at is null", [
        keep,
      ]),
    ).toBe(0);
  });

  it("someone else's card still cannot be merged (the function runs as the owner now)", async () => {
    const mine = await insertClient(t.db, rep, "Mine");
    const theirs = await insertClient(t.db, other, "Theirs");
    await expect(merge(mine, theirs)).rejects.toThrow(/not found/);
    expect(await num("select count(*) n from clients where id = $1", [theirs])).toBe(1);
  });
});

describe("database-2: a deleted file can be uploaded again", () => {
  it("allows the same bytes after a soft delete, still refuses a second live copy", async () => {
    const c = await insertClient(t.db, rep, "Docs Co");
    const id = await doc(c, sha("c"), "k/one");
    await expect(doc(c, sha("c"), "k/two")).rejects.toMatchObject({ code: "23505" });
    await q1("update documents set deleted_at = now() where id = $1", [id]);
    await doc(c, sha("c"), "k/three");
    expect(
      await num("select count(*) n from documents where client_id = $1 and sha256 = $2", [
        c,
        sha("c"),
      ]),
    ).toBe(2);
    expect(
      await num(
        "select count(*) n from documents where client_id = $1 and sha256 = $2 and deleted_at is null",
        [c, sha("c")],
      ),
    ).toBe(1);
  });
});

describe("database-3: send window and caps are checked together", () => {
  const set = (sql: string) => q1(`update shop_settings set ${sql}`);
  it("refuses a window that never opens and caps that leave no room", async () => {
    await expect(set("send_window_start = 17, send_window_end = 9")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(set("send_window_start = 10, send_window_end = 10")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(set("reserved_for_intake = 400, daily_cap = 300")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(set("amber_at = 1500, daily_cap = 1400")).rejects.toMatchObject({ code: "23514" });
    const row = (await q1("select send_window_start a, send_window_end b from shop_settings"))
      .rows[0];
    expect([row?.a, row?.b]).toEqual([9, 11]);
  });
  it("accepts good values, including a whole-day window", async () => {
    await set("send_window_start = 0, send_window_end = 24");
    await set("send_window_start = 9, send_window_end = 11");
    await set("daily_cap = 60, reserved_for_intake = 10, amber_at = 40");
    await set("daily_cap = 1500, reserved_for_intake = 150, amber_at = 1200");
  });
});

describe("database-5/6: helpers and grants", () => {
  it("a negative AI cost is stored as zero and cannot be inserted directly", async () => {
    const id = (
      await q1("select app.log_ai_run('x', 'm', 'v', 'h', 0, 0, -100000, '{}'::jsonb, null) as id")
    ).rows[0]?.id as string;
    expect(
      Number((await q1("select cost_cents from ai_runs where id = $1", [id])).rows[0]?.cost_cents),
    ).toBe(0);
    await expect(
      q1(
        "insert into ai_runs (purpose, model, prompt_version, input_hash, cost_cents) values ('x','m','v','h', -5)",
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("a rep can suppress only through their own merchant, in their own name", async () => {
    const mine = await insertClient(t.db, rep, "Sup Mine");
    const theirs = await insertClient(t.db, other, "Sup Theirs");
    const call = (client: string | null, by: string | null, key: string, as: string) =>
      t.db.withUser(as, (q) =>
        q.query("select app.suppress('email', $1, $1, 'complaint', '', $2, $3)", [key, client, by]),
      );
    await expect(call(theirs, rep, "k-theirs", rep)).rejects.toThrow(/not found/);
    await expect(call(null, rep, "k-null", rep)).rejects.toThrow(/not found/);
    await expect(call(mine, other, "k-by", rep)).rejects.toThrow(/own name/);
    await call(mine, rep, "k-mine", rep);
    await call(null, null, "k-manager", boss);
    expect(
      await num(
        "select count(*) n from suppressions where key_hash in ('k-theirs','k-null','k-by')",
      ),
    ).toBe(0);
    expect(
      await num("select count(*) n from suppressions where key_hash in ('k-mine','k-manager')"),
    ).toBe(2);
    await q1("select app.suppress('email', 'k-system', 'k-system', 'complaint', '', null, null)");
    expect(await num("select count(*) n from suppressions where key_hash = 'k-system'")).toBe(1);
  });
  it("an alert's link must be an in-app path", async () => {
    const ins = (href: string) =>
      q1("insert into user_alerts (user_id, kind, title, href) values ($1, 'x', 'T', $2)", [
        rep,
        href,
      ]);
    await expect(ins("https://evil.example/x")).rejects.toMatchObject({ code: "23514" });
    await expect(ins("//evil.example/x")).rejects.toMatchObject({ code: "23514" });
    await ins("/clients/abc");
    await ins("");
  });
  it("a rep session cannot rewrite a document's scan result, but can still delete and relabel", async () => {
    const c = await insertClient(t.db, rep, "Scan Co");
    const id = await doc(c, sha("d"), "k/scan");
    await q1("update documents set scan_status = 'rejected' where id = $1", [id]);
    await expect(
      t.db.withUser(rep, (q) =>
        q.query("update documents set scan_status = 'clean' where id = $1", [id]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(
      (await q1("select scan_status from documents where id = $1", [id])).rows[0]?.scan_status,
    ).toBe("rejected");
    await t.db.withUser(rep, (q) =>
      q.query(
        "update documents set kind = 'tax_return', deleted_at = now(), deleted_by = $2 where id = $1",
        [id, rep],
      ),
    );
    expect(
      await num(
        "select count(*) n from documents where id = $1 and deleted_at is not null and kind = 'tax_return'",
        [id],
      ),
    ).toBe(1);
  });
});

describe("database-7: indexes", () => {
  it("Follow Up's per-bucket live lookup is indexed", async () => {
    const names = (
      await q1("select indexname from pg_indexes where schemaname = 'public'")
    ).rows.map((r) => r.indexname as string);
    for (const n of [
      "enrollments_bucket_live_idx",
      "outbox_mailbox_idx",
      "documents_user_idx",
      "sheet_rows_client_idx",
    ])
      expect(names).toContain(n);
  });
});

describe("database-8: split-zone states use the area code", () => {
  const tz = async (state: string, phone: string) => {
    const c = await insertClient(t.db, rep, `TZ ${state} ${phone}`);
    await q1("update clients set state = $2, phone = $3 where id = $1", [c, state, phone]);
    return (await q1("select app.client_timezone(c) tz from clients c where id = $1", [c])).rows[0]
      ?.tz as string;
  };
  it("Pensacola is Central, El Paso is Mountain, and the plain cases are unchanged", async () => {
    expect(await tz("FL", "8505550100")).toBe("America/Chicago");
    expect(await tz("FL", "3055550100")).toBe("America/New_York");
    expect(await tz("TX", "9155550100")).toBe("America/Denver");
    expect(await tz("TX", "2145550100")).toBe("America/Chicago");
    // a Texas address with a New York number is still Texas
    expect(await tz("TX", "2125550100")).toBe("America/Chicago");
    // a state that is one zone ignores the number
    expect(await tz("CA", "2125550100")).toBe("America/Los_Angeles");
    // no state: the number decides
    expect(await tz("", "8505550100")).toBe("America/Chicago");
    // a manual zone always wins
    const c = await insertClient(t.db, rep, "TZ manual");
    await q1(
      "update clients set state = 'FL', phone = '8505550100', timezone = 'America/Denver' where id = $1",
      [c],
    );
    expect(
      (await q1("select app.client_timezone(c) tz from clients c where id = $1", [c])).rows[0]?.tz,
    ).toBe("America/Denver");
  });
});

describe("database-9: offboarding moves the newer tables", () => {
  it("approvals, applications, offers and brain preparations follow the book; working ones for the leaver fail", async () => {
    const leaver = await insertUser(t.pool, "leaver@x.com", "UTC");
    const heir = await insertUser(t.pool, "heir@x.com", "UTC");
    const c = await insertClient(t.db, leaver, "Leaver Co");
    await q1(
      "insert into approvals (client_id, user_id, amount_cents, status, closed_at, closed_reason) values ($1, $2, 1000000, 'closed', now(), 'x')",
      [c, leaver],
    );
    await q1(
      "insert into applications (client_id, user_id, fields, signer_name) values ($1, $2, '{}', 'Mike')",
      [c, leaver],
    );
    await q1(
      `insert into merchant_offers (client_id, user_id, token, funded_cents, factor_rate, frequency, payments, expires_at)
       values ($1, $2, 'tok-off-2', 5000000, 1.3, 'daily', 100, now() + interval '3 days')`,
      [c, leaver],
    );
    await q1(
      "insert into brain_preps (user_id, client_id, kind, trigger_key, status) values ($1, $2, 'plan', 'moved-1', 'ready')",
      [leaver, c],
    );
    await q1(
      "insert into brain_preps (user_id, kind, trigger_key, status) values ($1, 'plan', 'working-1', 'working')",
      [leaver],
    );

    await t.db.withUser(boss, (q) => q.query("select offboard_user($1, $2)", [leaver, heir]));

    for (const tbl of ["approvals", "applications", "merchant_offers"])
      expect(await num(`select count(*) n from ${tbl} where user_id = $1`, [leaver]), tbl).toBe(0);
    expect(
      await num("select count(*) n from approvals where client_id = $1 and user_id = $2", [
        c,
        heir,
      ]),
    ).toBe(1);
    expect(
      await num("select count(*) n from applications where client_id = $1 and user_id = $2", [
        c,
        heir,
      ]),
    ).toBe(1);
    expect(
      await num("select count(*) n from merchant_offers where client_id = $1 and user_id = $2", [
        c,
        heir,
      ]),
    ).toBe(1);
    expect(
      await num(
        "select count(*) n from brain_preps where trigger_key = 'moved-1' and user_id = $1",
        [heir],
      ),
    ).toBe(1);
    expect(
      (await q1("select status from brain_preps where trigger_key = 'working-1'")).rows[0]?.status,
    ).toBe("failed");
  });
});
