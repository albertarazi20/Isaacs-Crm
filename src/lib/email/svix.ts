/**
 * Resend signs webhooks the Svix way: HMAC-SHA256 over "<id>.<timestamp>.<body>" with the secret after "whsec_"
 * (base64). The header may carry several "v1,<sig>" entries during a key rotation; any match passes.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export function svixHeaders(h: { get(name: string): string | null }): SvixHeaders {
  return {
    id: h.get("svix-id"),
    timestamp: h.get("svix-timestamp"),
    signature: h.get("svix-signature"),
  };
}

export function signSvix(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export function verifySvix(
  secret: string,
  h: SvixHeaders,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > SVIX_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signSvix(secret, h.id, h.timestamp, body));
  for (const part of h.signature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}
