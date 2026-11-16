type Fetch = typeof fetch;

/**
 * Reading Gmail: the three calls the sync uses, as plain fetches. messages.list (first sync and the fallback poll),
 * history.list (incremental, from the stored historyId), messages.get (full headers + body). Bodies are decoded
 * here; nothing is interpreted.
 */

export interface GmailMessageMeta {
  id: string;
  threadId: string;
}

export interface GmailMessage extends GmailMessageMeta {
  historyId: string;
  internalDate: number;
  headers: Record<string, string>;
  text: string;
  attachmentNames: string[];
  snippet: string;
}

const base = "https://gmail.googleapis.com/gmail/v1/users/me";

async function call<T>(token: string, path: string, fetchImpl: Fetch): Promise<T> {
  const res = await fetchImpl(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Gmail ${res.status}: ${body.slice(0, 200)}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

/** Messages matching a Gmail search, newest first. `q` keeps the read small: after a date, from lender domains. */
export async function listMessages(
  token: string,
  q: string,
  fetchImpl: Fetch = fetch,
  max = 100,
): Promise<GmailMessageMeta[]> {
  const out: GmailMessageMeta[] = [];
  let pageToken = "";
  while (out.length < max) {
    const page = await call<{ messages?: GmailMessageMeta[]; nextPageToken?: string }>(
      token,
      `/messages?q=${encodeURIComponent(q)}&maxResults=${Math.min(100, max - out.length)}${pageToken ? `&pageToken=${pageToken}` : ""}`,
      fetchImpl,
    );
    out.push(...(page.messages ?? []));
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return out;
}

/** New message ids since a historyId. Returns null when the id is too old (Gmail answers 404): do a full list. */
export async function listHistory(
  token: string,
  startHistoryId: string,
  fetchImpl: Fetch = fetch,
): Promise<{ added: GmailMessageMeta[]; historyId: string } | null> {
  const added: GmailMessageMeta[] = [];
  let pageToken = "";
  let latest = startHistoryId;
  try {
    for (;;) {
      const page = await call<{
        history?: { id: string; messagesAdded?: { message: GmailMessageMeta }[] }[];
        historyId?: string;
        nextPageToken?: string;
      }>(
        token,
        `/history?startHistoryId=${encodeURIComponent(startHistoryId)}&historyTypes=messageAdded&labelId=INBOX${pageToken ? `&pageToken=${pageToken}` : ""}`,
        fetchImpl,
      );
      for (const h of page.history ?? [])
        for (const m of h.messagesAdded ?? []) added.push(m.message);
      if (page.historyId) latest = page.historyId;
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
  // de-dupe (a message can appear in several history records)
  const seen = new Set<string>();
  return {
    added: added.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true))),
    historyId: latest,
  };
}

interface Part {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: Part[];
}

function decode(data: string | undefined): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Plain text of a message: text/plain parts first; else HTML stripped to text. */
function extractText(part: Part, out: { plain: string[]; html: string[]; files: string[] }): void {
  if (part.filename && part.filename.trim() !== "" && part.body?.attachmentId)
    out.files.push(part.filename);
  const mt = (part.mimeType ?? "").toLowerCase();
  if (mt === "text/plain" && part.body?.data) out.plain.push(decode(part.body.data));
  else if (mt === "text/html" && part.body?.data) out.html.push(decode(part.body.data));
  for (const p of part.parts ?? []) extractText(p, out);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function getMessage(
  token: string,
  id: string,
  fetchImpl: Fetch = fetch,
): Promise<GmailMessage> {
  const m = await call<{
    id: string;
    threadId: string;
    historyId: string;
    internalDate: string;
    snippet?: string;
    payload: Part;
  }>(token, `/messages/${encodeURIComponent(id)}?format=full`, fetchImpl);
  const headers: Record<string, string> = {};
  for (const h of m.payload.headers ?? []) headers[h.name.toLowerCase()] = h.value;
  const out = { plain: [] as string[], html: [] as string[], files: [] as string[] };
  extractText(m.payload, out);
  const text = out.plain.length ? out.plain.join("\n") : htmlToText(out.html.join("\n"));
  return {
    id: m.id,
    threadId: m.threadId,
    historyId: m.historyId,
    internalDate: Number(m.internalDate),
    headers,
    text: text.slice(0, 60_000),
    attachmentNames: out.files,
    snippet: m.snippet ?? "",
  };
}

/** Message-IDs out of a References header. */
export function splitMessageIds(v: string | undefined): string[] {
  return (v ?? "").match(/<[^>]+>/g) ?? [];
}

export function parseAddress(v: string | undefined): { name: string; address: string } {
  const s = v ?? "";
  const m = /^\s*"?([^"<]*)"?\s*<([^>]+)>/.exec(s);
  if (m) return { name: (m[1] ?? "").trim(), address: (m[2] ?? "").trim().toLowerCase() };
  return { name: "", address: s.trim().toLowerCase() };
}
