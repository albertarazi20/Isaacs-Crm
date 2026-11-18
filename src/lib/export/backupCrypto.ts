import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { ENCRYPTED_BACKUP_FORMAT } from "./backup";
import { RestoreError } from "./restore";

/**
 * Passphrase encryption for a backup file. The file is customer data (names, phones, funding terms) that gets emailed
 * and left in Downloads; encrypted, it is useless to whoever finds it.
 *
 * AES-256-GCM with a key derived from the passphrase by scrypt (random 16-byte salt per file, random 12-byte nonce per
 * file). The header (version, KDF settings, salt, nonce) is bound to the ciphertext as GCM additional data, so a
 * changed header fails the same authentication check as a changed ciphertext. GCM cannot tell a wrong passphrase from
 * a tampered file; both fail the tag check and both refuse with one message. Nothing is decrypted, and so nothing is
 * restored, unless the tag verifies. There is no recovery: a lost passphrase means a lost backup.
 */

export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 1024;
/** Extension for a backup made with a passphrase. */
export const ENCRYPTED_BACKUP_EXTENSION = ".enc.json";

const ENVELOPE_VERSION = 1;
const CIPHER = "aes-256-gcm";
const KDF = "scrypt";
// OWASP's minimum for scrypt: N=2^17 (128 MiB), r=8, p=1. A file may only carry exactly these: a reader that honoured
// whatever cost a file asked for could be made to burn the machine's memory.
const SCRYPT = { N: 131072, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedBackup {
  format: typeof ENCRYPTED_BACKUP_FORMAT;
  version: typeof ENVELOPE_VERSION;
  cipher: typeof CIPHER;
  kdf: { name: typeof KDF; N: number; r: number; p: number; salt: string };
  nonce: string;
  tag: string;
  ciphertext: string;
}

/** A sentence for a person when a passphrase is not acceptable, or null when it is. */
export function passphraseProblem(passphrase: unknown): string | null {
  if (typeof passphrase !== "string") return "Type a passphrase";
  const length = [...passphrase.normalize("NFKC")].length;
  if (length < MIN_PASSPHRASE_LENGTH)
    return `The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`;
  if (length > MAX_PASSPHRASE_LENGTH)
    return `The passphrase can be at most ${MAX_PASSPHRASE_LENGTH} characters`;
  return null;
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase.normalize("NFKC"),
      salt,
      KEY_BYTES,
      { ...SCRYPT, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** The bytes GCM authenticates alongside the ciphertext: every header field, in a fixed order. */
function headerBytes(b: Pick<EncryptedBackup, "version" | "cipher" | "kdf" | "nonce">): Buffer {
  return Buffer.from(
    [
      ENCRYPTED_BACKUP_FORMAT,
      b.version,
      b.cipher,
      b.kdf.name,
      b.kdf.N,
      b.kdf.r,
      b.kdf.p,
      b.kdf.salt,
      b.nonce,
    ].join("|"),
    "utf8",
  );
}

export function isEncryptedBackup(file: unknown): file is EncryptedBackup {
  return (
    typeof file === "object" &&
    file !== null &&
    (file as { format?: unknown }).format === ENCRYPTED_BACKUP_FORMAT
  );
}

/** Encrypts the backup's JSON text. Returns the envelope as JSON text, ready to save as `.enc.json`. */
export async function encryptBackup(plaintext: string, passphrase: string): Promise<string> {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new RestoreError(problem);
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await deriveKey(passphrase, salt);
  const head = {
    version: ENVELOPE_VERSION,
    cipher: CIPHER,
    kdf: { name: KDF, ...SCRYPT, salt: salt.toString("base64") },
    nonce: nonce.toString("base64"),
  } as const;
  const cipher = createCipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(headerBytes(head));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: EncryptedBackup = {
    format: ENCRYPTED_BACKUP_FORMAT,
    ...head,
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(envelope);
}

const WRONG = "Wrong passphrase, or the file has been changed. Nothing was restored";
const NOT_READABLE =
  "That encrypted backup is damaged or from a newer version. Nothing was restored";

/** Decodes a base64 field to exactly `bytes` bytes (or any length when null), or null when it is not that. */
function bytesOf(value: unknown, bytes: number | null): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const buf = Buffer.from(value, "base64");
  return bytes !== null && buf.length !== bytes ? null : buf;
}

/**
 * Decrypts an envelope and returns the backup it holds (parsed, not yet checked: run it through checkBackup).
 * Throws a RestoreError, and returns nothing, for a wrong passphrase, a changed file or an unreadable one.
 */
export async function decryptBackup(file: unknown, passphrase: string): Promise<unknown> {
  if (!isEncryptedBackup(file)) throw new RestoreError("That file is not an encrypted backup");
  const f = file as unknown as Record<string, unknown>;
  const kdf = f.kdf as Record<string, unknown> | null;
  const salt = bytesOf(kdf?.salt, SALT_BYTES);
  const nonce = bytesOf(f.nonce, NONCE_BYTES);
  const tag = bytesOf(f.tag, TAG_BYTES);
  const ciphertext = bytesOf(f.ciphertext, null);
  if (
    f.version !== ENVELOPE_VERSION ||
    f.cipher !== CIPHER ||
    !kdf ||
    kdf.name !== KDF ||
    kdf.N !== SCRYPT.N ||
    kdf.r !== SCRYPT.r ||
    kdf.p !== SCRYPT.p ||
    !salt ||
    !nonce ||
    !tag ||
    !ciphertext
  )
    throw new RestoreError(NOT_READABLE);
  if (typeof passphrase !== "string" || passphrase.length === 0)
    throw new RestoreError("That backup is encrypted. Enter its passphrase");
  const key = await deriveKey(passphrase, salt);
  const head = {
    version: ENVELOPE_VERSION,
    cipher: CIPHER,
    kdf: { name: KDF, ...SCRYPT, salt: kdf.salt as string },
    nonce: f.nonce as string,
  } as const;
  let plain: string;
  try {
    const decipher = createDecipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(headerBytes(head));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new RestoreError(WRONG);
  }
  try {
    return JSON.parse(plain);
  } catch {
    throw new RestoreError(NOT_READABLE);
  }
}

/** Thrown by readBackupFile for an encrypted file when no passphrase was given, so the caller can ask for one. */
export class PassphraseRequired extends RestoreError {
  constructor() {
    super("That backup is encrypted. Enter its passphrase");
  }
}

/**
 * Reads a backup file's text, plain or encrypted, and returns the backup object (not yet checked: run it through
 * checkBackup). Touches no database, so a wrong passphrase can never leave anything half done.
 */
export async function readBackupFile(text: string, passphrase?: string): Promise<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RestoreError("That file is not a Selective CRM backup");
  }
  if (!isEncryptedBackup(parsed)) return parsed;
  if (!passphrase) throw new PassphraseRequired();
  return decryptBackup(parsed, passphrase);
}
