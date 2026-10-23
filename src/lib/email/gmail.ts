import { decryptSecret } from "../crypto";
import { buildRawEmail } from "./raw";

type Fetch = typeof fetch;

export class GmailReconnectError extends Error {
  constructor(message = "Gmail needs to be reconnected") {
    super(message);
    this.name = "GmailReconnectError";
  }
}

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

export async function sendViaGmail(
  creds: GmailCreds,
  cfg: GmailConfig,
  message: { to: string; subject: string; text: string },
  fetchImpl: Fetch = fetch,
): Promise<{ id: string; threadId: string }> {
  const token = await accessTokenFor(creds, cfg, fetchImpl);
  const raw = buildRawEmail({
    from: creds.googleEmail,
    to: message.to,
    subject: message.subject,
    text: message.text,
  });
  const res = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ raw }),
  });
  if (res.status === 401 || res.status === 403)
    throw new GmailReconnectError("Gmail rejected the send permission");
  if (!res.ok) throw new Error(`Gmail send failed (${res.status})`);
  return (await res.json()) as { id: string; threadId: string };
}
