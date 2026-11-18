import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKUP_TABLES, buildBackup, type Backup } from "@/lib/export/backup";
import { restoreBackup } from "@/lib/export/restore";
import { undoInput, wroteRecord } from "@/components/stage-move/forms";
import type { ClientCard } from "@/lib/data/types";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "UTC");
});
afterAll(async () => {
  await t.drop();
});

let seq = 0;

describe("C-2: a backup is one snapshot", () => {
  it("every row in a backup taken while another connection is writing has its parent in the same file", async () => {
    let stop = false;
    const writer = (async () => {
      while (!stop) {
        const id = await insertClient(t.db, a, `Writer ${(seq += 1)}`);
        await t.pool.query(
          "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'note', 'while backing up')",
          [a, id],
        );
      }
    })();
    try {
      for (let i = 0; i < 25; i += 1) {
        const b = await t.db.withUser(a, (q) => buildBackup(q));
        const ids = new Set((b.tables.clients ?? []).map((c) => c.id));
        for (const name of ["activities", "timers", "client_asks", "stips"]) {
          const orphans = (b.tables[name] ?? []).filter((r) => !ids.has(r.client_id));
          expect(orphans.length, `${name} rows without their merchant in the same file`).toBe(0);
        }
      }
    } finally {
      stop = true;
      await writer;
    }
  });
});

const card = (over: Partial<ClientCard> = {}): ClientCard =>
  ({
    id: "c1",
    stage: "interested",
    next_due_on: "2026-10-26",
    ...over,
  }) as ClientCard;

describe("C-3: no Undo for a move that booked a call", () => {
  it("wroteRecord counts callAt; undoInput then offers nothing", () => {
    expect(wroteRecord({ callAt: "2026-10-25T10:30" })).toBe(true);
    expect(wroteRecord({})).toBe(false);
    expect(
      undoInput(card(), "call_scheduled", wroteRecord({ callAt: "x" }), { today: "2026-10-23" }),
    ).toBeNull();
    expect(
      undoInput(card(), "call_scheduled", wroteRecord({}), { today: "2026-10-23" }),
    ).not.toBeNull();
  });
});

describe("C-5 and C-13: restore brings the settings back and wants an empty account", () => {
  it("time zone, signature, application link and digest settings are restored; a non-empty account is refused", async () => {
    const src = await createTestDb();
    const dst = await createTestDb();
    try {
      const u = await insertUser(src.pool, "src@x.com", "America/Chicago");
      await src.pool.query(
        "update app_users set signature = 'Best, Isaac', application_link = 'https://apply.example.com/x', digest_hour = 7 where id = $1",
        [u],
      );
      await insertClient(src.db, u, "Settings Pizza");
      const backup = JSON.parse(
        JSON.stringify(await src.db.withUser(u, (q) => buildBackup(q))),
      ) as Backup;
      const target = await insertUser(dst.pool, "dst@x.com", "UTC");
      const client = await dst.pool.connect();
      try {
        await client.query("begin");
        await restoreBackup(client, backup, target);
        await client.query("commit");
      } finally {
        client.release();
      }
      const { rows } = await dst.pool.query(
        "select timezone, signature, application_link, digest_hour, email from app_users where id = $1",
        [target],
      );
      expect(rows[0]).toMatchObject({
        timezone: "America/Chicago",
        signature: "Best, Isaac",
        application_link: "https://apply.example.com/x",
        digest_hour: 7,
        email: "dst@x.com", // the sign-in address is the account's own, never the file's
      });
      // an account with only a snippet in it is not empty
      const other = await insertUser(dst.pool, "other@x.com", "UTC");
      await dst.pool.query(
        "insert into snippets (user_id, title, kind, body, sort) values ($1, 'Already here', 'text', 'Hi', 0)",
        [other],
      );
      const c2 = await dst.pool.connect();
      try {
        await expect(restoreBackup(c2, backup, other)).rejects.toThrow(/already has snippets/);
      } finally {
        c2.release();
      }
    } finally {
      await src.drop();
      await dst.drop();
    }
  });
});

describe("C-6: an older backup still restores after a new column with a default", () => {
  it("restore_rows takes the column list from the file", async () => {
    const x = await createTestDb();
    try {
      const u = await insertUser(x.pool, "x@x.com", "UTC");
      await x.pool.query("alter table snippets add column pinned boolean not null default false");
      const n = await x.pool.query<{ n: number }>(
        "select app.restore_rows('snippets', $1::jsonb) as n",
        [
          JSON.stringify([
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              user_id: u,
              title: "Hi",
              kind: "text",
              body: "Hi there",
              sort: 0,
              created_at: "2026-10-01T00:00:00Z",
            },
          ]),
        ],
      );
      expect(n.rows[0]?.n).toBe(1);
      expect((await x.pool.query("select pinned from snippets")).rows[0]).toEqual({
        pinned: false,
      });
    } finally {
      await x.drop();
    }
  });
  it("every table in the schema is either in the backup or on the named exclusion list", async () => {
    const { rows } = await t.pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );
    const EXCLUDED = [
      "app_users",
      "gmail_connections",
      "lead_tokens",
      "reminders_sent",
      "job_runs",
      "schema_migrations",
      "stages",
      // Shop-level and system tables added for Selective CRM (0290–0430). The JSON file stays the merchant-level
      // export one person can keep; the shop's full state is the database backup (Supabase daily + pg_dump).
      "access_log",
      "user_alerts", // 0500: the alert feed, system state
      "applications", // 0530: the signed application record; the PDF itself is in documents
      "assistant_threads", // 0541: a person's conversations with the assistant, private to them
      "passcode_attempts", // 0570: failed passcode sign-in counters per address, system-only throwaway state
      "link_opens", // 0547: page-view signals, worth nothing after a few days
      // 0553: the shop's approval emails (shop-level, like templates) and the approvals on them (funding-stage state,
      // like the offers above); both are in the database backup
      "approval_emails",
      "approvals",
      "merchant_offers", // 0555: offers made to merchants, like the approvals they come from; in the database backup
      "brain_preps", // 0554: what the assistant prepared in the background, throwaway working state like its threads
      "ai_runs",
      "app_state_tz",
      "area_code_tz",
      "bucket_steps",
      "buckets",
      "commission_ledger",
      "commission_plans",
      "deals",
      "decline_reasons",
      "document_links",
      "document_views",
      "documents",
      "enrollments",
      "goals",
      "inbound_emails",
      "mail_sync_state",
      "mailbox_sent_sync", // stream 1: the Sent-mail watermark per mailbox
      "mailboxes",
      "outbox",
      "proposed_updates",
      "reply_tags", // stream 1: which merchant replies the classifier has tagged, and how
      "send_ledger",
      "sheet_rows",
      "sheet_sources",
      "shop_registrations",
      "shop_settings",
      "state_rules",
      "suppressions",
      "template_variants",
      "templates",
      "upload_sessions",
      "webhook_events",
      "winback_members",
      "winback_pools",
      "commission_closes", // stream 3
      "commission_statements", // stream 3
      "fundings_corrections", // stream 3
      "winback_reasons", // stream 3
      // the removed features' tables: the schema stays, the backup no longer carries them
      "positions",
      "competing_offers",
      "fundings",
      "funders",
      "submissions",
      "offers",
      "rescue_nudges", // stream 3
      "backdoor_reports", // stream 3
    ];
    const uncovered = rows
      .map((r) => r.table_name)
      .filter((n) => !BACKUP_TABLES.includes(n) && !EXCLUDED.includes(n));
    expect(uncovered).toEqual([]);
  });
});

describe("C-9: files the app downloads are kept out of git", () => {
  it(".gitignore names the backup and the CSV exports", () => {
    const ig = readFileSync(".gitignore", "utf8").split("\n");
    for (const p of [
      "isaac-backup-*.json",
      "isaac-clients-*.csv",
      "isaac-activity-*.csv",
      "isaac-notes-*.csv",
    ])
      expect(ig, p).toContain(p);
  });
});
