type Fetch = typeof fetch;

export interface ResendConfig {
  apiKey: string;
  from: string;
}

/** Plain REST call — one endpoint, no SDK. Returns Resend's message id. */
export async function sendViaResend(
  cfg: ResendConfig,
  message: {
    to: string;
    subject: string;
    text: string;
    html: string;
    replyTo?: string;
    headers?: Readonly<Record<string, string>>;
    attachments?: readonly { filename: string; contentType: string; bytes: Uint8Array }[];
  },
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      from: cfg.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      ...(message.headers ? { headers: message.headers } : {}),
      ...(message.attachments?.length
        ? {
            attachments: message.attachments.map((a) => ({
              filename: a.filename,
              content: Buffer.from(a.bytes).toString("base64"),
              content_type: a.contentType,
            })),
          }
        : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!res.ok || !body.id)
    throw new Error(`Resend failed (${res.status}${body.message ? `: ${body.message}` : ""})`);
  return body.id;
}
