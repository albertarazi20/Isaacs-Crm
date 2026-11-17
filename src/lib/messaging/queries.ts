import type { Db } from "../db";
import type { SnippetKind } from "./defaults";

export interface SnippetRow {
  id: string;
  title: string;
  kind: SnippetKind;
  body: string;
  sort: number;
}

export interface MessageSettings {
  signature: string;
  applicationLink: string;
}

export async function getMessageSettings(q: Db): Promise<MessageSettings> {
  const { rows } = await q.query<{ signature: string; application_link: string }>(
    "select signature, application_link from app_users where id = app.current_user_id()",
  );
  return { signature: rows[0]?.signature ?? "", applicationLink: rows[0]?.application_link ?? "" };
}

export async function listSnippets(q: Db): Promise<SnippetRow[]> {
  const { rows } = await q.query<SnippetRow>(
    "select id, title, kind, body, sort from snippets order by kind, sort, created_at, id",
  );
  return rows;
}

/** What the Text and Email dialogs need for one merchant, in one round trip. */
export interface MessagingContext extends MessageSettings {
  snippets: SnippetRow[];
  wantedAmountCents: number | null;
}

export async function getMessagingContext(q: Db, clientId: string): Promise<MessagingContext> {
  const settings = await getMessageSettings(q);
  const snippets = await listSnippets(q);
  const ask = await q.query<{ w: string | null }>(
    "select wanted_amount_cents::text as w from client_asks where client_id = $1 order by created_at desc limit 1",
    [clientId],
  );
  const w = ask.rows[0]?.w;
  return {
    ...settings,
    snippets,
    wantedAmountCents: w ? Number(w) : null,
  };
}
