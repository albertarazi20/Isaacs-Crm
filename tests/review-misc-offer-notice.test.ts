import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BlobStore } from "@/lib/docs/storage";
import { retryOfferNotices } from "@/lib/system/offerNotice";
import { acceptOffer } from "@/lib/system/offers";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0] as T;

const memory: BlobStore = {
  kind: "local",
  put: async () => undefined,
  delete: async () => undefined,
  get: async () => ({
    bytes: new TextEncoder().encode("%PDF-1.4\n%%EOF\n"),
    contentType: "application/pdf",
  }),
};

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
});
afterAll(() => t.drop());

async function acceptedOffer(name: string, scanAge: string) {
  const client = (
    await one<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email) values ($1, $2, 'Pat Doe', '3055550141', 'pat@x.com') returning id",
      [rep, name],
    )
  ).id;
  await t.pool.query(
    `insert into documents (user_id, client_id, kind, filename, content_type, size_bytes, sha256, storage_key, source, scan_status, created_at,
                            label_by, label_confidence, label_reason)
     values ($1, $2, 'voided_check', 'f.pdf', 'application/pdf', 10, $4, $5, 'upload_link', 'pending', now() - $3::text::interval,
             'rule', 0.7, 'chosen by the merchant on the offer page')`,
    [rep, client, scanAge, client.replaceAll("-", "").repeat(2), `${client}/k`],
  );
  const o = await one<{ id: string; token: string }>(
    `insert into merchant_offers (client_id, user_id, funded_cents, factor_rate, frequency, payments, expires_at, docs)
     values ($1, $2, 5000000, 1.3, 'weekly', 26, now() + interval '2 days', array['voided_check']::text[]) returning id, token`,
    [client, rep],
  );
  await acceptOffer(o.token, { name: "Pat Doe", email: "", ip: "1.1.1.1" }, t.db);
  return o.id;
}

const retry = async (mails: { subject: string; text: string; attachments: unknown[] }[]) =>
  retryOfferNotices({
    store: memory,
    senders: {
      gmail: async (_u, m) => void mails.push(m),
      resend: null,
    },
    appUrl: "https://crm.example.com",
    db: t.db,
  });

describe("an accepted offer's email and a document that never finishes its check", () => {
  it("waits for a fresh pending document", async () => {
    const id = await acceptedOffer("Fresh Pending", "5 minutes");
    const mails: { subject: string; text: string; attachments: unknown[] }[] = [];
    const r = await retry(mails);
    expect(r.sent).toBe(0);
    const o = await one<{ done: boolean }>(
      "select accept_notified_at is not null as done from merchant_offers where id = $1",
      [id],
    );
    expect(o.done).toBe(false);
  });

  it("sends after an hour without the unchecked document, and says so", async () => {
    const id = await acceptedOffer("Stuck Pending", "3 hours");
    const mails: { subject: string; text: string; attachments: unknown[] }[] = [];
    const r = await retry(mails);
    expect(r.sent).toBeGreaterThanOrEqual(1);
    const o = await one<{ done: boolean }>(
      "select accept_notified_at is not null as done from merchant_offers where id = $1",
      [id],
    );
    expect(o.done).toBe(true);
    const mail = mails.find((m) => m.text.includes("Stuck Pending"));
    expect(mail?.attachments).toHaveLength(0);
    expect(mail?.text).toContain("Not checked yet, so not attached");
    expect(mail?.text).toContain("Voided check");
  });
});
