export interface RawEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

function assertHeaderSafe(name: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${name} contains a line break`);
}

/** One plain address. "a@b.com,c@d.com" would silently email a second person from Isaac's own Gmail. */
const SINGLE_ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

function encodeSubject(subject: string): string {
  return /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

/** RFC 2822 message as base64url — the shape Gmail's users.messages.send wants in `raw`. */
export function buildRawEmail(m: RawEmail): string {
  for (const [k, v] of Object.entries({
    from: m.from,
    to: m.to,
    subject: m.subject,
    replyTo: m.replyTo ?? "",
  })) {
    assertHeaderSafe(k, v);
  }
  if (!SINGLE_ADDRESS.test(m.to)) throw new Error("to must be exactly one email address");
  const body = Buffer.from(m.text, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  const headers = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    `Subject: ${encodeSubject(m.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const message = `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
  return Buffer.from(message, "utf8").toString("base64url");
}
