import { decryptSecret } from "../crypto";
import { type Attachment, buildRawEmail } from "./raw";

type Fetch = typeof fetch;

export class GmailReconnectError extends Error {
  constructor(message = "Gmail needs to be reconnected") {
    super(message);
    this.name = "GmailReconnectError";
  }
}

/** Google error reasons on a 403 that signing in again cannot fix. */
const NOT_A_PERMISSION_PROBLEM = new Set([
  "accessNotConfigured",
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "dailyLimitExceeded",
  "quotaExceeded",
  "domainPolicy",
]);

export interface GmailCreds {
  refreshTokenEnc: string;
  googleEmail: string;
}

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  tokenEncKey: string | undefined;
}

/** Trade the stored refresh token for a short-lived access token. `invalid_grant` means reconnect. */
export async function accessTokenFor(
  creds: GmailCreds,
  cfg: GmailConfig,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: decryptSecret(creds.refreshTokenEnc, cfg.tokenEncKey),
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (body.error === "invalid_grant") throw new GmailReconnectError();
  if (!res.ok || !body.access_token)
    throw new Error(
      `Google token refresh failed (${res.status}${body.error ? ` ${body.error}` : ""})`,
    );
  return body.access_token;
}

export interface OutgoingMessage {
  to: string;
  subject: string;
  text: string;
  /** The designed version (approval emails); sent as multipart/alternative. */
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: readonly string[];
  /** Gmail thread to append to (a chase on the same thread). */
  threadId?: string;
  headers?: Readonly<Record<string, string>>;
  attachments?: readonly Attachment[];
}

export async function sendViaGmail(
  creds: GmailCreds,
  cfg: GmailConfig,
  message: OutgoingMessage,
  fetchImpl: Fetch = fetch,
): Promise<{ id: string; threadId: string }> {
  const token = await accessTokenFor(creds, cfg, fetchImpl);
  const raw = buildRawEmail({
    from: creds.googleEmail,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    messageId: message.messageId,
    inReplyTo: message.inReplyTo,
    references: message.references,
    headers: message.headers,
    attachments: message.attachments,
  });
  // a message with files goes to the upload address as the message itself: the JSON send takes small bodies only,
  // and base64url on top of the files' own base64 would push documents past it
  const res = message.attachments?.length
    ? await fetchImpl(
        "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media",
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "message/rfc822" },
          signal: AbortSignal.timeout(45_000),
          body: Buffer.from(raw, "base64url"),
        },
      )
    : await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify(message.threadId ? { raw, threadId: message.threadId } : { raw }),
      });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; errors?: { reason?: string }[] };
    };
    const reason = err.error?.errors?.[0]?.reason;
    // A 403 for a reason that is not about this person's permission (the Gmail API switched off in the Google
    // project, a quota) is not fixed by signing in again: say what Google said instead of looping on "reconnect".
    const notPermission = reason !== undefined && NOT_A_PERMISSION_PROBLEM.has(reason);
    if (res.status === 401 || (res.status === 403 && !notPermission))
      throw new GmailReconnectError("Gmail rejected the send permission");
    throw new Error(
      `Gmail send failed (${res.status}${reason ? ` ${reason}` : ""}${err.error?.message ? `: ${err.error.message}` : ""})`,
    );
  }
  return (await res.json()) as { id: string; threadId: string };
}
