import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UserError } from "@/lib/data/mutations";
import { deleteSnippet, saveMessageSettings, saveSnippet } from "@/lib/messaging/mutations";
import { getMessageSettings, getMessagingContext, listSnippets } from "@/lib/messaging/queries";
import { MAX_SNIPPETS, messageSettingsSchema, snippetSchema } from "@/lib/messaging/schemas";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let b: string;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "a@x.com");
  b = await insertUser(t.pool, "b@x.com");
});
afterAll(async () => {
  await t.drop();
});

/** What is really in the table, read as the database owner (bypassing row-level security). */
const rows = async (userId: string) =>
  (
    await t.pool.query<{ title: string; kind: string; body: string; sort: number }>(
      "select title, kind, body, sort from snippets where user_id = $1 order by kind, sort, created_at",
      [userId],
    )
  ).rows;

const save = (
  userId: string,
  input: { title: string; kind?: "text" | "email"; body?: string; id?: string },
) =>
  t.db.withUser(userId, (q) =>
    saveSnippet(q, snippetSchema.parse({ kind: "text", body: "Hi {first_name}", ...input })),
  );

describe("saving snippets really changes the database", () => {
  it("inserts a row owned by the signed-in user", async () => {
    const saved = await save(a, { title: "Quick hello", body: "Hi {first_name} from {sender}" });
    expect(saved).toMatchObject({ title: "Quick hello", kind: "text", sort: 0 });
    expect(await rows(a)).toEqual([
      { title: "Quick hello", kind: "text", body: "Hi {first_name} from {sender}", sort: 0 },
    ]);
    const owner = await t.pool.query("select user_id from snippets where id = $1", [saved.id]);
    expect(owner.rows[0].user_id).toBe(a);
  });

  it("numbers new snippets after the last one of the same kind", async () => {
    await save(a, { title: "Second text", body: "two" });
    await save(a, { title: "First email", kind: "email", body: "Subject: Hi\n\nBody" });
    const list = await rows(a);
    expect(list.map((r) => [r.kind, r.title, r.sort])).toEqual([
      ["email", "First email", 0],
      ["text", "Quick hello", 0],
      ["text", "Second text", 1],
    ]);
  });

  it("edits in place: the row changes, nothing is duplicated", async () => {
    const [first] = await t.db.withUser(a, listSnippets);
    expect(first).toBeDefined();
    const before = (await rows(a)).length;
    const updated = await save(a, {
      id: first!.id,
      title: "Renamed",
      kind: first!.kind,
      body: "New words for {business}",
    });
    expect(updated.id).toBe(first!.id);
    expect((await rows(a)).length).toBe(before);
    const real = await t.pool.query("select title, body from snippets where id = $1", [first!.id]);
    expect(real.rows[0]).toEqual({ title: "Renamed", body: "New words for {business}" });
  });

  it("deletes the row", async () => {
    const x = await save(a, { title: "Doomed" });
    expect((await t.pool.query("select 1 from snippets where id = $1", [x.id])).rowCount).toBe(1);
    await t.db.withUser(a, (q) => deleteSnippet(q, x.id));
    expect((await t.pool.query("select 1 from snippets where id = $1", [x.id])).rowCount).toBe(0);
  });

  it("deleting or editing something that isn't there says so in plain words", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    await expect(t.db.withUser(a, (q) => deleteSnippet(q, ghost))).rejects.toThrow(
      "That snippet no longer exists",
    );
    await expect(save(a, { id: ghost, title: "Nope" })).rejects.toThrow(
      "That snippet no longer exists",
    );
  });
});

describe("one snippet per title per kind per user", () => {
  it("refuses a duplicate, ignoring case and spacing, with a plain message — and stores nothing", async () => {
    await save(a, { title: "Win-back" });
    const before = (await rows(a)).length;
    for (const title of ["Win-back", "win-back", "  WIN-BACK  "]) {
      const err = await save(a, { title }).catch((e: unknown) => e);
      expect(err, title).toBeInstanceOf(UserError);
      expect((err as Error).message).toBe(
        "You already have a text snippet called “Win-back”. Pick another name.".replace(
          "Win-back",
          title.trim(),
        ),
      );
    }
    expect((await rows(a)).length).toBe(before);
  });
  it("the database enforces it too, not just the app", async () => {
    await expect(
      t.pool.query(
        "insert into snippets (user_id, title, kind, body) values ($1, 'win-back ', 'text', 'x')",
        [a],
      ),
    ).rejects.toThrow(/snippets_user_kind_title_key/);
  });
  it("lets the same title exist as a text and an email", async () => {
    await save(a, { title: "Renewal check", kind: "text", body: "t" });
    await save(a, { title: "Renewal check", kind: "email", body: "Subject: s\n\ne" });
    const both = (await rows(a)).filter((r) => r.body === "t" || r.body.startsWith("Subject: s"));
    expect(both.map((r) => r.kind).sort()).toEqual(["email", "text"]);
  });
  it("lets two users use the same title", async () => {
    await save(b, { title: "Win-back", body: "b's words" });
    expect((await rows(b)).map((r) => r.title)).toEqual(["Win-back"]);
  });
  it("renaming onto an existing title is refused", async () => {
    const x = await save(a, { title: "Rename me" });
    await expect(save(a, { id: x.id, title: "Quick hello" })).rejects.toBeInstanceOf(UserError);
    const real = await t.pool.query("select title from snippets where id = $1", [x.id]);
    expect(real.rows[0].title).toBe("Rename me");
  });
});

describe("row-level security: one user can't see or touch another's snippets", () => {
  it("user B sees only their own", async () => {
    const seen = await t.db.withUser(b, listSnippets);
    expect(seen.map((s) => s.body)).toEqual(["b's words"]);
    const count = await t.db.withUser(
      b,
      async (q) =>
        (await q.query<{ n: number }>("select count(*)::int as n from snippets")).rows[0]?.n,
    );
    expect(count).toBe(1);
  });
  it("B can't read A's snippet by id", async () => {
    const mine = (await t.db.withUser(a, listSnippets))[0]!;
    const res = await t.db.withUser(b, (q) =>
      q.query("select * from snippets where id = $1", [mine.id]),
    );
    expect(res.rowCount).toBe(0);
  });
  it("B's update and delete of A's snippet change nothing", async () => {
    const mine = (await t.db.withUser(a, listSnippets))[0]!;
    const res = await t.db.withUser(b, async (q) => ({
      upd: (await q.query("update snippets set body = 'HACKED' where id = $1", [mine.id])).rowCount,
      del: (await q.query("delete from snippets where id = $1", [mine.id])).rowCount,
    }));
    expect(res).toEqual({ upd: 0, del: 0 });
    const real = await t.pool.query("select body from snippets where id = $1", [mine.id]);
    expect(real.rows[0].body).toBe(mine.body);
    // and through the app's own code
    await expect(t.db.withUser(b, (q) => deleteSnippet(q, mine.id))).rejects.toThrow(
      "That snippet no longer exists",
    );
    await expect(save(b, { id: mine.id, title: "Mine now" })).rejects.toThrow(
      "That snippet no longer exists",
    );
    expect((await t.pool.query("select 1 from snippets where id = $1", [mine.id])).rowCount).toBe(
      1,
    );
  });
  it("B can't insert a snippet owned by A", async () => {
    await expect(
      t.db.withUser(b, (q) =>
        q.query(
          "insert into snippets (user_id, title, kind, body) values ($1, 'Evil', 'text', 'x')",
          [a],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    expect((await rows(a)).some((r) => r.title === "Evil")).toBe(false);
  });
  it("B can't move a snippet to A, or take one over, by updating user_id", async () => {
    const own = (await t.db.withUser(b, listSnippets))[0]!;
    await expect(
      t.db.withUser(b, (q) =>
        q.query("update snippets set user_id = $1 where id = $2", [a, own.id]),
      ),
    ).rejects.toThrow(/row-level security/);
    const real = await t.pool.query("select user_id from snippets where id = $1", [own.id]);
    expect(real.rows[0].user_id).toBe(b);
  });
  it("with no user set, nothing is visible", async () => {
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role isaac_app");
      expect((await c.query("select count(*)::int as n from snippets")).rows[0].n).toBe(0);
      await c.query("rollback");
    } finally {
      c.release();
    }
  });
  it("deleting a user deletes their snippets", async () => {
    const tmp = await insertUser(t.pool, "tmp@x.com");
    await save(tmp, { title: "Gone soon" });
    expect((await rows(tmp)).length).toBe(1);
    await t.pool.query("delete from app_users where id = $1", [tmp]);
    expect((await rows(tmp)).length).toBe(0);
  });
});

describe("table constraints", () => {
  const insert = (title: string, kind: string, body: string) =>
    t.pool.query("insert into snippets (user_id, title, kind, body) values ($1, $2, $3, $4)", [
      a,
      title,
      kind,
      body,
    ]);
  it("rejects a blank title or body, an unknown kind, and oversize text", async () => {
    await expect(insert("  ", "text", "x")).rejects.toThrow(/snippets_title_check/);
    await expect(insert("T1", "text", "   ")).rejects.toThrow(/snippets_body_check/);
    await expect(insert("T2", "sms", "x")).rejects.toThrow(/snippets_kind_check/);
    await expect(insert("x".repeat(81), "text", "x")).rejects.toThrow(/snippets_title_check/);
    await expect(insert("T3", "text", "x".repeat(5001))).rejects.toThrow(/snippets_body_check/);
  });
  it("stops at the snippet limit", async () => {
    const u = await insertUser(t.pool, "limit@x.com");
    await t.pool.query(
      "insert into snippets (user_id, title, kind, body) select $1, 's' || i, 'text', 'x' from generate_series(1, $2) i",
      [u, MAX_SNIPPETS],
    );
    await expect(save(u, { title: "One too many" })).rejects.toThrow(
      `You can save up to ${MAX_SNIPPETS} snippets`,
    );
    expect((await rows(u)).length).toBe(MAX_SNIPPETS);
    // editing at the limit still works
    const first = (await t.db.withUser(u, listSnippets))[0]!;
    await save(u, { id: first.id, title: "Still editable" });
    expect((await rows(u)).some((r) => r.title === "Still editable")).toBe(true);
  });
});

describe("signature and application link", () => {
  it("start empty", async () => {
    expect(await t.db.withUser(a, getMessageSettings)).toEqual({
      signature: "",
      applicationLink: "",
    });
  });
  it("save through the app and really change the row", async () => {
    await t.db.withUser(a, (q) =>
      saveMessageSettings(
        q,
        messageSettingsSchema.parse({
          signature: "Isaac Cohen\nCommercial funding · 555-0100",
          applicationLink: "https://apply.example.com/isaac",
        }),
      ),
    );
    const real = await t.pool.query(
      "select signature, application_link from app_users where id = $1",
      [a],
    );
    expect(real.rows[0]).toEqual({
      signature: "Isaac Cohen\nCommercial funding · 555-0100",
      application_link: "https://apply.example.com/isaac",
    });
    expect(await t.db.withUser(a, getMessageSettings)).toEqual({
      signature: "Isaac Cohen\nCommercial funding · 555-0100",
      applicationLink: "https://apply.example.com/isaac",
    });
    // B is untouched
    expect(await t.db.withUser(b, getMessageSettings)).toEqual({
      signature: "",
      applicationLink: "",
    });
  });
  it("can be cleared again", async () => {
    await t.db.withUser(a, (q) =>
      saveMessageSettings(q, messageSettingsSchema.parse({ signature: "", applicationLink: "" })),
    );
    expect(await t.db.withUser(a, getMessageSettings)).toEqual({
      signature: "",
      applicationLink: "",
    });
  });
  it("the database refuses a link that isn't a web address, or is too long, or a huge signature", async () => {
    for (const link of [
      "javascript:alert(1)",
      "ftp://x.com",
      "apply.example.com",
      "https://a b.com",
      `https://x.com/${"a".repeat(500)}`,
    ]) {
      await expect(
        t.db.withUser(a, (q) =>
          q.query("update app_users set application_link = $1 where id = $2", [link, a]),
        ),
        link,
      ).rejects.toThrow(/check constraint/);
    }
    await expect(
      t.db.withUser(a, (q) =>
        q.query("update app_users set signature = $1 where id = $2", ["x".repeat(2001), a]),
      ),
    ).rejects.toThrow(/check constraint/);
    expect((await t.db.withUser(a, getMessageSettings)).applicationLink).toBe("");
  });
  it("B can't change A's signature", async () => {
    const res = await t.db.withUser(b, (q) =>
      q.query("update app_users set signature = 'HACKED' where id = $1", [a]),
    );
    expect(res.rowCount).toBe(0);
    expect((await t.db.withUser(a, getMessageSettings)).signature).toBe("");
  });
});

describe("column grants on app_users are exactly what we meant", () => {
  it("lets the app write the signature and the link", async () => {
    await t.db.withUser(a, (q) =>
      q.query(
        "update app_users set signature = 'S', application_link = 'https://a.example' where id = $1",
        [a],
      ),
    );
    const real = await t.pool.query(
      "select signature, application_link from app_users where id = $1",
      [a],
    );
    expect(real.rows[0]).toEqual({ signature: "S", application_link: "https://a.example" });
  });
  it("still refuses notify_email — an editable reminder address would redirect the morning digest", async () => {
    await expect(
      t.db.withUser(a, (q) =>
        q.query("update app_users set notify_email = 'evil@example.com' where id = $1", [a]),
      ),
    ).rejects.toThrow(/permission denied/);
    const real = await t.pool.query("select notify_email from app_users where id = $1", [a]);
    expect(real.rows[0].notify_email).toBeNull();
  });
  it("still refuses email and id, and keeps the original column grants", async () => {
    await expect(
      t.db.withUser(a, (q) => q.query("update app_users set email = 'z@x.com' where id = $1", [a])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.db.withUser(a, (q) =>
        q.query("update app_users set id = gen_random_uuid() where id = $1", [a]),
      ),
    ).rejects.toThrow(/permission denied/);
    await t.db.withUser(a, (q) =>
      q.query(
        "update app_users set name = 'Isaac', timezone = 'America/Chicago', digest_enabled = false, digest_hour = 7 where id = $1",
        [a],
      ),
    );
    const real = await t.pool.query(
      "select name, timezone, digest_hour from app_users where id = $1",
      [a],
    );
    expect(real.rows[0]).toEqual({ name: "Isaac", timezone: "America/Chicago", digest_hour: 7 });
  });
  it("lists the writable columns, and notify_email is not one of them", async () => {
    const { rows: grants } = await t.pool.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_name = 'app_users' and grantee = 'isaac_app' and privilege_type = 'UPDATE'
        order by column_name`,
    );
    expect(grants.map((g) => g.column_name)).toEqual([
      // role, active and invited_by are writable only through the manager guard trigger (0290)
      "active",
      "application_link",
      "digest_enabled",
      "digest_hour",
      "invited_by",
      "name",
      "role",
      "signature",
      "timezone",
    ]);
  });
  it("gives the app no way to delete or insert users", async () => {
    await expect(
      t.db.withUser(a, (q) => q.query("delete from app_users where id = $1", [a])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("what the Text and Email dialogs load", () => {
  it("returns settings, saved snippets, the latest ask — only for this merchant", async () => {
    const u = await insertUser(t.pool, "ctx@x.com");
    const c1 = await insertClient(t.db, u, "Ctx Pizza");
    await t.db.withUser(u, async (q) => {
      await q.query(
        "insert into client_asks (user_id, client_id, wanted_amount_cents) values ($1, $2, 3000000), ($1, $2, 6000000)",
        [u, c1],
      );
    });
    await save(u, { title: "Mine", body: "Hi {first_name}" });
    await t.db.withUser(u, (q) =>
      saveMessageSettings(
        q,
        messageSettingsSchema.parse({ signature: "Sig", applicationLink: "https://x.example/a" }),
      ),
    );
    const ctx = await t.db.withUser(u, (q) => getMessagingContext(q, c1));
    expect(ctx).toMatchObject({
      signature: "Sig",
      applicationLink: "https://x.example/a",
      wantedAmountCents: 6_000_000,
    });
    expect(ctx.snippets.map((s) => s.title)).toEqual(["Mine"]);
    const none = await t.db.withUser(u, (q) =>
      getMessagingContext(q, "00000000-0000-4000-8000-000000000000"),
    );
    expect(none.wantedAmountCents).toBeNull();
    // another user can't see this merchant's ask through the same call
    const other = await t.db.withUser(b, (q) => getMessagingContext(q, c1));
    expect(other.wantedAmountCents).toBeNull();
    expect(other.snippets.map((s) => s.title)).toEqual(["Win-back"]);
  });
});
