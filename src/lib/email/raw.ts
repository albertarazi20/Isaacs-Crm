export interface RawEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** A designed version: the message becomes multipart/alternative with the text as the fallback. */
  html?: string;
  replyTo?: string;
  /** Our own Message-ID, so a lender's reply can be matched by In-Reply-To even when Gmail re-threads. */
  messageId?: string;
  /** Threading headers when this is a reply (a chase on the same thread). */
  inReplyTo?: string;
  references?: readonly string[];
  /** Extra headers, e.g. List-Unsubscribe. Names are validated; values may not break lines. */
  headers?: Readonly<Record<string, string>>;
}

function assertHeaderSafe(name: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${name} contains a line break`);
}

/** One plain address. "a@b.com,c@d.com" would silently email a second person from Isaac's own Gmail. */
const SINGLE_ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/**
 * A non-ASCII subject becomes several RFC 2047 encoded words of at most 45 bytes each (an encoded word may not pass
 * 75 characters), folded onto continuation lines. A code point is never split between two words.
 */
function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const words: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of subject) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > 45) {
      words.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  if (current) words.push(current);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** RFC 2822 message as base64url — the shape Gmail's users.messages.send wants in `raw`. */
export function buildRawEmail(m: RawEmail): string {
  for (const [k, v] of Object.entries({
    from: m.from,
    to: m.to,
    subject: m.subject,
    replyTo: m.replyTo ?? "",
    messageId: m.messageId ?? "",
    inReplyTo: m.inReplyTo ?? "",
    references: (m.references ?? []).join(" "),
  })) {
    assertHeaderSafe(k, v);
  }
  for (const [k, v] of Object.entries(m.headers ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,60}$/.test(k)) throw new Error(`bad header name: ${k}`);
    assertHeaderSafe(k, v);
  }
  if (!SINGLE_ADDRESS.test(m.to)) throw new Error("to must be exactly one email address");
  const b64 = (s: string) =>
    Buffer.from(s, "utf8")
      .toString("base64")
      .replace(/(.{76})/g, "$1\r\n");
  const body = b64(m.text);
  const headers = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    ...(m.messageId ? [`Message-ID: ${m.messageId}`] : []),
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references && m.references.length ? [`References: ${m.references.join(" ")}`] : []),
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    `Subject: ${encodeSubject(m.subject)}`,
    "MIME-Version: 1.0",
  ];
  let message: string;
  if (m.html !== undefined && m.html.trim() !== "") {
    // a boundary that cannot occur in base64 parts (it has characters base64 never uses)
    const boundary = `=_alt_${Buffer.from(m.subject + m.to)
      .toString("hex")
      .slice(0, 16)}_${Date.now().toString(36)}`;
    const part = (type: string, content: string) =>
      [
        `--${boundary}`,
        `Content-Type: ${type}; charset="UTF-8"`,
        "Content-Transfer-Encoding: base64",
        "",
        b64(content),
      ].join("\r\n");
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    message = `${headers.join("\r\n")}\r\n\r\n${part("text/plain", m.text)}\r\n${part("text/html", m.html)}\r\n--${boundary}--\r\n`;
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
    message = `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
  }
  return Buffer.from(message, "utf8").toString("base64url");
}
