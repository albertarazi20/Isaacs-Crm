import type { Db } from "../db";
import { UserError } from "../data/mutations";
import type { MessageSettingsInput, SnippetInput } from "./schemas";
import { MAX_SNIPPETS } from "./schemas";
import type { SnippetRow } from "./queries";

const COLUMNS = "id, title, kind, body, sort";

export async function saveSnippet(q: Db, input: SnippetInput): Promise<SnippetRow> {
  try {
    if (input.id) {
      const res = await q.query<SnippetRow>(
        `update snippets set title = $2, kind = $3, body = $4 where id = $1 returning ${COLUMNS}`,
        [input.id, input.title, input.kind, input.body],
      );
      const row = res.rows[0];
      if (!row) throw new UserError("That snippet no longer exists");
      return row;
    }
    const count = await q.query<{ n: number }>("select count(*)::int as n from snippets");
    if ((count.rows[0]?.n ?? 0) >= MAX_SNIPPETS) {
      throw new UserError(`You can save up to ${MAX_SNIPPETS} snippets. Delete one you don't use.`);
    }
    const res = await q.query<SnippetRow>(
      `insert into snippets (user_id, title, kind, body, sort)
       values (app.current_user_id(), $1, $2, $3,
               coalesce((select max(sort) + 1 from snippets where kind = $2), 0))
       returning ${COLUMNS}`,
      [input.title, input.kind, input.body],
    );
    const row = res.rows[0];
    if (!row) throw new Error("snippet insert returned no row");
    return row;
  } catch (e) {
    if ((e as { code?: string } | null)?.code === "23505") {
      throw new UserError(
        `You already have a ${input.kind} snippet called “${input.title}”. Pick another name.`,
      );
    }
    throw e;
  }
}

export async function deleteSnippet(q: Db, id: string): Promise<void> {
  const res = await q.query("delete from snippets where id = $1", [id]);
  if (res.rowCount === 0) throw new UserError("That snippet no longer exists");
}

export async function saveMessageSettings(q: Db, input: MessageSettingsInput): Promise<void> {
  await q.query(
    "update app_users set signature = $1, application_link = $2 where id = app.current_user_id()",
    [input.signature, input.applicationLink],
  );
}
