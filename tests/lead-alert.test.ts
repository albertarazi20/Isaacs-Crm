import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as m from "@/lib/data/mutations";
import { newClientSchema } from "@/lib/data/schemas";
import { buildNewLeadAlert } from "@/lib/mca/digest";
import { NEW_LEAD_ALERTS_PER_DAY, sendNewLeadAlert } from "@/lib/system/leadAlert";
import type { DigestSender } from "@/lib/system/reminders";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

describe("buildNewLeadAlert", () => {
  const lead = {
    clientId: "c1",
    businessName: "Mike's Pizza",
    contactName: "Mike Ross",
    phone: "+13055550100",
    wantedAmount: "$50k",
    source: "My website",
  };
  it("is short, says call now, and links to the merchant", () => {
    const a = buildNewLeadAlert(lead, "https://app.test");
    expect(a.subject).toBe("New lead: Mike's Pizza — call now");
    expect(a.text).toContain("(305) 555-0100");
    expect(a.text).toContain("Wants $50k");
    expect(a.text).toContain("https://app.test/clients/c1");
  });
  it("can't be used to break the subject line or inject HTML", () => {
    const a = buildNewLeadAlert(
      { ...lead, businessName: "Evil\r\nBcc: x@y.z <script>alert(1)</script>" },
      "https://app.test",
    );
    expect(a.subject).not.toMatch(/[\r\n]/);
    expect(a.html).not.toContain("<script>");
    expect(a.html).toContain("&lt;script&gt;");
  });
  it("copes with no phone and no extras", () => {
    const a = buildNewLeadAlert(
      { ...lead, phone: "", contactName: "", wantedAmount: null, source: "" },
      "https://app.test",
    );
    expect(a.text).toContain("no phone — email only");
    expect(a.text).not.toContain("Contact:");
  });
});

describe("sendNewLeadAlert", () => {
  let t: TestDb;
  let a: string;
  let b: string;
  beforeAll(async () => {
    t = await createTestDb();
    a = await insertUser(t.pool, "isaac@x.com", "America/New_York");
    b = await insertUser(t.pool, "other@x.com", "UTC");
  });
  afterAll(async () => {
    await t.drop();
  });

  const lead = async (user: string, name: string) =>
    (
      await t.db.withUser(user, (q) =>
        m.createClient(
          q,
          newClientSchema.parse({ businessName: name, phone: "3055550100", source: "Vendor" }),
          {
            today: t.today,
            timezone: "UTC",
          },
        ),
      )
    ).id;
  const ok = () =>
    vi.fn(async () => "resend_1") as unknown as DigestSender & ReturnType<typeof vi.fn>;
  const NOW = () => new Date(`${t.today}T15:00:00Z`);
  const run = (send: DigestSender, userId: string, clientId: string, cap?: number) =>
    sendNewLeadAlert({
      db: t.db,
      userId,
      clientId,
      now: NOW(),
      appUrl: "https://app.test",
      send,
      cap,
    });
  const claims = async (user: string) =>
    (
      await t.pool.query(
        "select ref, provider_id from reminders_sent where user_id = $1 and kind = 'new_lead'",
        [user],
      )
    ).rows;

  it("emails the owner once and records the claim with the provider id", async () => {
    const id = await lead(a, "Alert One");
    const send = ok();
    expect(await run(send, a, id)).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    const [to, msg] = send.mock.calls[0] ?? [];
    expect(to).toBe("isaac@x.com");
    expect(msg.subject).toBe("New lead: Alert One — call now");
    expect(await claims(a)).toEqual([{ ref: id, provider_id: "resend_1" }]);
  });
  it("a second call for the same lead sends nothing", async () => {
    const id = await lead(a, "Alert Two");
    expect(await run(ok(), a, id)).toBe("sent");
    const again = ok();
    expect(await run(again, a, id)).toBe("skipped");
    expect(again).not.toHaveBeenCalled();
  });
  it("a failed send rolls the claim back, so a retry still sends", async () => {
    const id = await lead(a, "Alert Three");
    const boom = vi.fn(async () => {
      throw new Error("Resend down");
    }) as unknown as DigestSender;
    await expect(run(boom, a, id)).rejects.toThrow("Resend down");
    expect((await claims(a)).some((c) => c.ref === id)).toBe(false);
    expect(await run(ok(), a, id)).toBe("sent");
  });
  it("respects the reminder switch in Settings", async () => {
    const id = await lead(a, "Alert Four");
    await t.pool.query("update app_users set digest_enabled = false where id = $1", [a]);
    const send = ok();
    expect(await run(send, a, id)).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
    await t.pool.query("update app_users set digest_enabled = true where id = $1", [a]);
  });
  it("won't alert for a merchant in the trash or another user's merchant", async () => {
    const trashed = await lead(a, "Alert Trashed");
    await t.db.withUser(a, (q) => m.trashClient(q, trashed));
    const send = ok();
    expect(await run(send, a, trashed)).toBe("skipped");
    const theirs = await lead(b, "B Lead");
    expect(await run(send, a, theirs)).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
  });
  it(`stops at ${NEW_LEAD_ALERTS_PER_DAY} a day so a flood of leads is not a flood of email`, async () => {
    const user = await insertUser(t.pool, "flood@x.com", "UTC");
    const send = ok();
    const results: string[] = [];
    for (let i = 0; i < 4; i += 1)
      results.push(await run(send, user, await lead(user, `Flood ${i}`), 3));
    expect(results).toEqual(["sent", "sent", "sent", "capped"]);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
