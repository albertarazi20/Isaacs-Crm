import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalStore } from "@/lib/docs/storage";
import { addDocument, fileEmailAttachment } from "@/lib/docs/upload";
import { forwardToLender, type Sender } from "@/lib/inbox/submit";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n%%EOF\n`);

describe("ops sends documents to a lender in one click", () => {
  let t: TestDb;
  let dir: string;
  let store: LocalStore;
  let rep: string;
  let manager: string;
  let pizza: string;
  let sub: string;
  let docA: string;
  let docB: string;

  beforeAll(async () => {
    t = await createTestDb();
    dir = mkdtempSync(join(tmpdir(), "isaac-fwd-"));
    store = new LocalStore(dir);
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
    await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
      manager,
    ]);
    pizza = await insertClient(t.db, rep, "Pizza Palace");
    const pearl = (
      await t.pool.query<{ id: string }>(
        "insert into funders (user_id, name, submission_email) values ($1, 'Pearl', 'subs@pearl.com') returning id",
        [manager],
      )
    ).rows[0]!.id;
    await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [pizza]));
    const deal = (
      await t.pool.query<{ id: string }>("select id from deals where client_id = $1", [pizza])
    ).rows[0]!.id;
    sub = (
      await t.pool.query<{ id: string }>(
        `insert into submissions (user_id, client_id, funder_id, deal_id, sent_on, status, sent_via, gmail_thread_id, gmail_message_id)
         values ($1, $2, $3, $4, current_date - 2, 'stips_requested', 'crm', 'thr_9', '<m9@x>') returning id`,
        [rep, pizza, pearl, deal],
      )
    ).rows[0]!.id;
    docA = (
      await t.db.withUser(rep, (q) =>
        addDocument(q, store, {
          clientId: pizza,
          filename: "Oct_statement.pdf",
          contentType: "application/pdf",
          bytes: pdf("oct"),
          uploadedBy: rep,
          today: t.today,
          kind: "bank_statement",
          period: "2026-10-01",
        }),
      )
    ).documentId;
    docB = (
      await t.db.withUser(rep, (q) =>
        addDocument(q, store, {
          clientId: pizza,
          filename: "void_check.pdf",
          contentType: "application/pdf",
          bytes: pdf("check"),
          uploadedBy: rep,
          today: t.today,
        }),
      )
    ).documentId;
  });
  afterAll(async () => {
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("mints a watermarked link per document, emails the lender on the submission thread, logs it, and the stips wait is over", async () => {
    const sent: Parameters<Sender>[0][] = [];
    const send: Sender = async (m) => {
      sent.push(m);
      return { id: "g1", threadId: m.threadId ?? "new" };
    };
    const r = await t.db.withUser(rep, (q) =>
      forwardToLender(q, {
        submissionId: sub,
        documentIds: [docA, docB],
        appUrl: "https://crm.test",
        senderName: "Ops One",
        note: "Both attached as links.",
        createdBy: rep,
        send,
      }),
    );
    expect(r).toEqual({ sent: true, links: 2 });
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.to).toBe("subs@pearl.com");
    expect(m.subject).toBe("Re: [D-1] Pizza Palace — documents");
    expect(m.threadId).toBe("thr_9");
    expect(m.inReplyTo).toBe("<m9@x>");
    expect(m.text.match(/https:\/\/crm\.test\/d\/[A-Za-z0-9]+/g)).toHaveLength(2);
    expect(m.text).toContain("Oct 2026 bank statement");
    expect(m.text).toContain("Both attached as links.");
    const links = await t.pool.query<{
      watermark: string;
      lender_id: string | null;
      max_downloads: number;
    }>(
      "select watermark, lender_id, max_downloads from document_links where document_id in ($1, $2)",
      [docA, docB],
    );
    expect(links.rows).toHaveLength(2);
    expect(
      links.rows.every(
        (l) =>
          l.watermark === "Prepared for Pearl" && l.lender_id !== null && l.max_downloads === 10,
      ),
    ).toBe(true);
    const s = await t.pool.query<{ status: string }>(
      "select status from submissions where id = $1",
      [sub],
    );
    expect(s.rows[0]?.status).toBe("sent");
    const act = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 order by occurred_at desc limit 1",
      [pizza],
    );
    expect(act.rows[0]?.body).toBe("Sent 2 documents to Pearl");
  });

  it("refuses a file that is not clean yet, and a lender with no email", async () => {
    const pending = await fileEmailAttachment(t.db, store, {
      clientId: pizza,
      filename: "scan.pdf",
      contentType: "application/pdf",
      bytes: pdf("new"),
      today: t.today,
    });
    const send: Sender = async () => ({ id: "g", threadId: "t" });
    await expect(
      t.db.withUser(rep, (q) =>
        forwardToLender(q, {
          submissionId: sub,
          documentIds: [pending!.documentId],
          appUrl: "https://crm.test",
          senderName: "Ops",
          createdBy: rep,
          send,
        }),
      ),
    ).rejects.toThrow(/still being checked/);
    await t.pool.query("update funders set submission_email = '' where name = 'Pearl'");
    await expect(
      t.db.withUser(rep, (q) =>
        forwardToLender(q, {
          submissionId: sub,
          documentIds: [docA],
          appUrl: "https://crm.test",
          senderName: "Ops",
          createdBy: rep,
          send,
        }),
      ),
    ).rejects.toThrow(/no submission email/);
  });
});
