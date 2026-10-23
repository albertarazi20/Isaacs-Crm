import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** `isl_` + 43 URL-safe characters (256 bits). The prefix lets a leaked token be recognised and revoked. */
export const TOKEN_PREFIX = "isl_";
const TOKEN_RE = /^isl_[A-Za-z0-9_-]{43}$/;

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The token from an `Authorization: Bearer …` header, or null if it's missing or not shaped like ours. */
export function parseBearer(header: string | null): string | null {
  // The scheme is case-insensitive (RFC 7235): "bearer isl_…" is as good as "Bearer isl_…".
  const m = /^bearer ([^\s]+)$/i.exec(header ?? "");
  const token = m?.[1];
  return token && TOKEN_RE.test(token) ? token : null;
}

/** Constant-time compare for hashes held in memory. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Enough of the token to recognise it later, never enough to use it. */
export const tokenHint = (token: string): string => `${token.slice(0, 8)}…${token.slice(-4)}`;

export const MAX_BODY_BYTES = 20_000;
export const MAX_PER_MINUTE = 30;

/** New merchants one token may add in a (UTC) day. Duplicates that only add a note don't count. */
export const MAX_NEW_PER_DAY = 200;
export const MAX_ACTIVE_TOKENS = 10;

/** Read a JSON body without trusting Content-Length, refusing anything over the cap. */
export async function readLimitedJson(
  req: Request,
  max = MAX_BODY_BYTES,
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string }> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) return { ok: false, status: 413, error: "That request is too large" };
  const reader = req.body?.getReader();
  if (!reader) return { ok: false, status: 400, error: "Send the merchant as a JSON body" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return { ok: false, status: 413, error: "That request is too large" };
    }
    chunks.push(value);
  }
  try {
    // Some tools put a byte-order mark in front of the JSON; it is not part of it.
    return {
      ok: true,
      value: JSON.parse(
        Buffer.concat(chunks)
          .toString("utf8")
          .replace(/^\uFEFF/, ""),
      ),
    };
  } catch {
    return { ok: false, status: 400, error: "That isn't valid JSON" };
  }
}
