import { db } from "../db";
import { encryptSecret } from "../crypto";
import { env } from "../env";
import { GmailReconnectError, sendViaGmail } from "../email/gmail";

export interface GmailStatus {
  connected: boolean;
  needsReconnect: boolean;
  googleEmail: string | null;
}

export async function saveGmailConnection(args: {
  userId: string;
  googleEmail: string;
  refreshToken: string;
  scope: string;
}): Promise<void> {
  const enc = encryptSecret(args.refreshToken, env().TOKEN_ENC_KEY);
  await db.withSystem((q) =>
    q.query(
      `insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status, last_error)
       values ($1, $2, $3, $4, 'ok', null)
       on conflict (user_id) do update
         set google_email = excluded.google_email, refresh_token_enc = excluded.refresh_token_enc,
             scope = excluded.scope, status = 'ok', last_error = null`,
      [args.userId, args.googleEmail, enc, args.scope],
    ),
  );
}

export async function gmailStatus(userId: string): Promise<GmailStatus> {
  return db.withSystem(async (q) => {
    const { rows } = await q.query<{ google_email: string; status: string }>(
      "select google_email, status from gmail_connections where user_id = $1",
      [userId],
    );
    const row = rows[0];
    return {
      connected: Boolean(row) && row?.status === "ok",
      needsReconnect: row?.status === "needs_reconnect",
      googleEmail: row?.google_email ?? null,
    };
  });
}

export async function disconnectGmail(userId: string): Promise<void> {
  await db.withSystem((q) => q.query("delete from gmail_connections where user_id = $1", [userId]));
}

/** Sends as the user via the Gmail API. A dead grant flips the connection to needs_reconnect. */
export async function sendEmailAsUser(
  userId: string,
  message: { to: string; subject: string; text: string },
) {
  const e = env();
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) throw new Error("Google is not configured");
  const row = await db.withSystem(async (q) => {
    const { rows } = await q.query<{
      google_email: string;
      refresh_token_enc: string;
      status: string;
    }>("select google_email, refresh_token_enc, status from gmail_connections where user_id = $1", [
      userId,
    ]);
    return rows[0];
  });
  if (!row) throw new GmailReconnectError("Gmail is not connected");
  if (row.status !== "ok") throw new GmailReconnectError();
  try {
    return await sendViaGmail(
      { refreshTokenEnc: row.refresh_token_enc, googleEmail: row.google_email },
      {
        clientId: e.GOOGLE_CLIENT_ID,
        clientSecret: e.GOOGLE_CLIENT_SECRET,
        tokenEncKey: e.TOKEN_ENC_KEY,
      },
      message,
    );
  } catch (err) {
    if (err instanceof GmailReconnectError) {
      await db.withSystem((q) =>
        q.query(
          "update gmail_connections set status = 'needs_reconnect', last_error = $2 where user_id = $1",
          [userId, err.message],
        ),
      );
    }
    throw err;
  }
}
