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

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

export interface GmailMessage extends GmailMessageMeta {
  historyId: string;
  internalDate: number;
  headers: Record<string, string>;
  text: string;
  attachmentNames: string[];
  attachments: GmailAttachment[];
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

/** Messages matching a Gmail search, newest first. `q` keeps the read small: after a date, in the inbox. */
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
function extractText(
  part: Part,
  out: { plain: string[]; html: string[]; files: string[]; attachments: GmailAttachment[] },
): void {
  if (part.filename && part.filename.trim() !== "" && part.body?.attachmentId) {
    out.files.push(part.filename);
    out.attachments.push({
      filename: part.filename,
      mimeType: (part.mimeType ?? "application/octet-stream").toLowerCase(),
      attachmentId: part.body.attachmentId,
      size: part.body.size ?? 0,
    });
  }
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
  for (const h of m.payload.headers ?? []) {
    const name = h.name.toLowerCase();
    // Gmail prepends its own Authentication-Results above everything the sender wrote. Only that first header, with
    // Google's own authserv-id, counts: a later one (or a duplicate with another id) is the sender's, never ours.
    if (name === "authentication-results") {
      if (!("authentication-results" in headers) && authservId(h.value) === "mx.google.com")
        headers[name] = h.value;
      continue;
    }
    headers[name] = h.value;
  }
  const out = {
    plain: [] as string[],
    html: [] as string[],
    files: [] as string[],
    attachments: [] as GmailAttachment[],
  };
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
    attachments: out.attachments,
    snippet: m.snippet ?? "",
  };
}

/** The bytes of one attachment. Gmail returns base64url; sizes over 25 MB are refused before the call. */
export async function getAttachment(
  token: string,
  messageId: string,
  attachmentId: string,
  fetchImpl: Fetch = fetch,
): Promise<Uint8Array> {
  const a = await call<{ data?: string; size?: number }>(
    token,
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    fetchImpl,
  );
  if (!a.data) return new Uint8Array(0);
  return new Uint8Array(Buffer.from(a.data.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
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

/** The authserv-id of an Authentication-Results header: the host that wrote it, before the first ";". */
export function authservId(header: string): string {
  return (header.split(";")[0] ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** The domain of an "a@b.com", "@b.com" or "b.com" value, lower-cased, without brackets or trailing dots. */
function domainOf(v: string | undefined): string {
  const x = (v ?? "").trim().replace(/^["<(]+|[">)]+$/g, "");
  return (x.includes("@") ? x.slice(x.lastIndexOf("@") + 1) : x).replace(/\.$/, "").toLowerCase();
}

/** Relaxed DMARC alignment without a public-suffix list: the same domain, or one is a subdomain of the other. */
function aligned(a: string, b: string): boolean {
  return a !== "" && b !== "" && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
}

type Verdict = "pass" | "fail" | null;

/**
 * Decode an Authentication-Results header into pass/fail for SPF and DKIM. Each result is read as its own clause (so
 * "spf=pass" inside a comment or another method's text never counts). With `fromAddress`, a pass counts only when the
 * domain it vouches for (SPF smtp.mailfrom, DKIM header.d / header.i) lines up with the From domain: a message sent
 * from attacker.com with SPF and DKIM passing for attacker.com is not a message from the merchant.
 */
export function authResults(
  header: string | null,
  fromAddress?: string,
): { spf: boolean | null; dkim: boolean | null } {
  if (!header) return { spf: null, dkim: null };
  const from = fromAddress === undefined ? null : domainOf(fromAddress);
  let spf: Verdict = null;
  let dkim: Verdict = null;
  for (const clause of header.split(";").slice(1)) {
    const c = clause
      .replace(/\([^)]*\)/g, " ")
      .trim()
      .toLowerCase();
    const method = /^(spf|dkim)\s*=\s*([a-z]+)/.exec(c);
    if (!method) continue;
    const ok = method[2] === "pass";
    let pass = ok;
    if (ok && from !== null) {
      const d =
        method[1] === "spf"
          ? domainOf(/smtp\.mailfrom\s*=\s*(\S+)/.exec(c)?.[1])
          : domainOf(/header\.d\s*=\s*(\S+)/.exec(c)?.[1] ?? /header\.i\s*=\s*(\S+)/.exec(c)?.[1]);
      pass = aligned(d, from);
    }
    const next: Verdict = pass ? "pass" : "fail";
    if (method[1] === "spf") spf = spf === "pass" ? spf : next;
    else dkim = dkim === "pass" ? dkim : next;
  }
  return {
    spf: spf === null ? null : spf === "pass",
    dkim: dkim === null ? null : dkim === "pass",
  };
}

/**
 * The DMARC rule: a sender is verified when at least ONE of SPF or DKIM passes and is aligned with the From domain.
 * (Third-party senders such as Resend, Mailchimp or a help desk often pass only one of the two aligned: SPF for their
 * own bounce domain, DKIM for the merchant's.) Pass the result of `authResults(header, fromAddress)`.
 */
export function senderVerified(auth: { spf: boolean | null; dkim: boolean | null }): boolean {
  return auth.spf === true || auth.dkim === true;
}
