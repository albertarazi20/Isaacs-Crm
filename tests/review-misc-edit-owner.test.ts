import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refuseAnotherRepsOnEdit } from "@/lib/leads/editOwner";
import { OwnedElsewhereError } from "@/lib/leads/owner";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let mike: string;
let dana: string;
let mikes: string;

const insert = async (user: string, name: string, phone: string, email: string) =>
  (
    await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email) values ($1, $2, 'Pat', $3, $4) returning id",
      [user, name, phone, email],
    )
  ).rows[0]!.id;

beforeAll(async () => {
  t = await createTestDb();
  mike = await insertUser(t.pool, "mike@x.com");
  dana = await insertUser(t.pool, "dana@x.com");
  await t.pool.query("update app_users set name = 'Dana' where id = $1", [dana]);
  // a pre-existing duplicate: Mike's card shares a phone and email with Dana's card
  mikes = await insert(mike, "Shared Pizza", "3055550111", "pat@shared.com");
  await insert(dana, "Shared Pizza Too", "3055550111", "pat@shared.com");
});
afterAll(async () => {
  await t.drop();
});

const edit = (fields: { phone?: string; email?: string }) =>
  t.db.withUser(mike, (q) => refuseAnotherRepsOnEdit(q, mikes, fields));

describe("editing a card against another rep's merchants", () => {
  it("lets the rep re-save the phone and email the card already holds", async () => {
    await expect(
      edit({ phone: "(305) 555-0111", email: "PAT@shared.com" }),
    ).resolves.toBeUndefined();
    await expect(edit({})).resolves.toBeUndefined();
  });

  it("still refuses a phone or email changed onto another rep's merchant", async () => {
    const other = await insert(dana, "Dana Deli", "7865550122", "deli@dana.com");
    expect(other).toBeTruthy();
    await expect(edit({ phone: "786-555-0122" })).rejects.toBeInstanceOf(OwnedElsewhereError);
    await expect(edit({ email: "deli@dana.com" })).rejects.toThrow(/Already in the system: Dana/);
    // a changed value that nobody owns is fine
    await expect(edit({ phone: "2125550100", email: "new@x.com" })).resolves.toBeUndefined();
  });
});
