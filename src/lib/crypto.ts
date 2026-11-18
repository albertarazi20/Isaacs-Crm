import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const TAG_BYTES = 16;

function keyFrom(base64: string | undefined): Buffer {
  if (!base64) throw new Error("TOKEN_ENC_KEY is not set");
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENC_KEY must be 32 bytes, base64 encoded");
  return key;
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, all base64url. */
export function encryptSecret(plain: string, keyB64: string | undefined): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(keyB64), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ct]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function decryptSecret(blob: string, keyB64: string | undefined): string {
  const [version, iv, tag, ct] = blob.split(".");
  // An empty plaintext encrypts to an empty ciphertext segment, which is still a valid blob.
  if (version !== VERSION || !iv || !tag || ct === undefined)
    throw new Error("unrecognised secret format");
  const tagBytes = Buffer.from(tag, "base64url");
  // Node accepts a 4-byte GCM tag unless told otherwise, which cuts forgery resistance from 2^-128 to 2^-32.
  if (tagBytes.length !== TAG_BYTES) throw new Error("unrecognised secret format");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(keyB64), Buffer.from(iv, "base64url"), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(tagBytes);
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString(
    "utf8",
  );
}
