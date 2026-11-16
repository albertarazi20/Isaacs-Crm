import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalStore } from "@/lib/docs/storage";
import { fileEmailAttachment, listDocuments } from "@/lib/docs/upload";
import { getAttachment, getMessage } from "@/lib/inbox/gmailRead";
import { submitToLenders, type Sender } from "@/lib/inbox/submit";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

const b64url = (s: string | Uint8Array) => Buffer.from(s).toString("base64url");
const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n%%EOF\n`);

describe("Gmail attachments", () => {
  it("the parser lists every attachment with its id and the downloader decodes the bytes", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/attachments/att1"))
        return new Response(JSON.stringify({ data: b64url(pdf("october")), size: 40 }), {
          status: 200,
        });
      return new Response(
        JSON.stringify({
          id: "m1",
          threadId: "t1",
          historyId: "9",
          internalDate: "1700000000000",
          snippet: "statements attached",
          payload: {
            mimeType: "multipart/mixed",
            headers: [
              { name: "From", value: "Mike <mike@pizza.com>" },
              { name: "Subject", value: "Re: statements" },
            ],
            parts: [
              { mimeType: "text/plain", body: { data: b64url("here you go") } },
              {
                mimeType: "application/pdf",
                filename: "Chase_Oct_2026.pdf",
                body: { attachmentId: "att1", size: 40 },
              },
              {
                mimeType: "image/png",
                filename: "logo.png",
                body: { attachmentId: "att2", size: 900 },
              },
            ],
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const m = await getMessage("tok", "m1", fetchImpl);
    expect(m.text).toBe("here you go");
    expect(m.attachments).toEqual([
      {
        filename: "Chase_Oct_2026.pdf",
        mimeType: "application/pdf",
        attachmentId: "att1",
        size: 40,
      },
      { filename: "logo.png", mimeType: "image/png", attachmentId: "att2", size: 900 },
    ]);
    const bytes = await getAttachment("tok", "m1", "att1", fetchImpl);
    expect(new TextDecoder().decode(bytes)).toContain("october");
  });
});

describe("filing and the shotgun check", () => {
  let t: TestDb;
  let dir: string;
  let store: LocalStore;
  let rep: string;
  let manager: string;
  let pizza: string;
  let prev: string;
  let prevName: string;

  beforeAll(async () => {
    t = await createTestDb();
    dir = mkdtempSync(join(tmpdir(), "isaac-att-"));
    store = new LocalStore(dir);
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
    await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
      manager,
    ]);
    pizza = await insertClient(t.db, rep, "Pizza Palace");
    const d = await t.pool.query<{ p: string; n: string }>(
      "select (date_trunc('month', current_date) - interval '1 month')::date::text as p, to_char(date_trunc('month', current_date) - interval '1 month', 'Mon_YYYY') as n",
    );
    prev = d.rows[0]!.p;
    prevName = d.rows[0]!.n;
    await t.db.withUser(rep, (q) =>
      q.query("select add_stips($1, $2::jsonb)", [
        pizza,
        JSON.stringify([{ kind: "bank_statement", period: prev }]),
      ]),
    );
  });
  afterAll(async () => {
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a forwarded statement becomes a document, ticks the stip and waits for the scan; a signature logo is ignored", async () => {
    const r = await fileEmailAttachment(t.db, store, {
      clientId: pizza,
      filename: `Chase_Statement_${prevName}.pdf`,
      contentType: "application/pdf",
      bytes: pdf("stmt"),
      today: t.today,
    });
    expect(r).toMatchObject({ kind: "bank_statement", period: prev, duplicate: false });
    const docs = await t.db.withUser(rep, (q) => listDocuments(q, pizza));
    expect(docs.map((d) => [d.source, d.scan_status])).toEqual([["email", "pending"]]);
    const stip = await t.pool.query<{ r: string | null }>(
      "select received_at::text as r from stips where client_id = $1",
      [pizza],
    );
    expect(stip.rows[0]?.r).not.toBeNull();
    expect(
      await fileEmailAttachment(t.db, store, {
        clientId: pizza,
        filename: "logo.png",
        contentType: "image/png",
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
        today: t.today,
      }),
    ).toBeNull();
    expect(
      await fileEmailAttachment(t.db, store, {
        clientId: pizza,
        filename: "evil.exe",
        contentType: "application/octet-stream",
        bytes: new TextEncoder().encode("MZ"),
        today: t.today,
      }),
    ).toBeNull();
  });

  it("sending past the shop's lender limit is refused unless done on purpose, and then it is logged", async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 7; i++) {
      ids.push(
        (
          await t.pool.query<{ id: string }>(
            "insert into funders (user_id, name, submission_email) values ($1, $2, $3) returning id",
            [manager, `Lender ${i}`, `subs${i}@lender.com`],
          )
        ).rows[0]!.id,
      );
    }
    await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [pizza]));
    const sent: string[] = [];
    const send: Sender = async (m) => {
      sent.push(m.to);
      return { id: `g${sent.length}`, threadId: `t${sent.length}` };
    };
    const base = { clientId: pizza, senderName: "Josh", senderEmail: "rep@x.com" };
    await expect(
      t.db.withUser(rep, (q) => submitToLenders(q, { ...base, funderIds: ids }, send)),
    ).rejects.toThrow(/7 lenders; the shop limit is 6/);
    expect(sent).toEqual([]);
    const ok = await t.db.withUser(rep, (q) =>
      submitToLenders(q, { ...base, funderIds: ids.slice(0, 6) }, send),
    );
    expect(ok.submissions).toHaveLength(6);
    // the seventh on top of six already out needs the override; the override is written down
    await expect(
      t.db.withUser(rep, (q) => submitToLenders(q, { ...base, funderIds: ids.slice(6) }, send)),
    ).rejects.toThrow(/shop limit/);
    const forced = await t.db.withUser(rep, (q) =>
      submitToLenders(q, { ...base, funderIds: ids.slice(6), force: true }, send),
    );
    expect(forced.submissions).toHaveLength(1);
    const note = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and body like 'Shotgun override%'",
      [pizza],
    );
    expect(note.rows[0]?.body).toBe("Shotgun override by Josh: 7 lenders (shop limit 6)");
  });
});
