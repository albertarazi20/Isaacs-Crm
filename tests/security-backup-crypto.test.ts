import { beforeAll, describe, expect, it } from "vitest";
import { ENCRYPTED_BACKUP_FORMAT } from "@/lib/export/backup";
import {
  decryptBackup,
  encryptBackup,
  isEncryptedBackup,
  MIN_PASSPHRASE_LENGTH,
  PassphraseRequired,
  passphraseProblem,
  readBackupFile,
  type EncryptedBackup,
} from "@/lib/export/backupCrypto";
import { checkBackup, RestoreError } from "@/lib/export/restore";

const PASS = "correct horse battery staple";
const PLAIN = JSON.stringify({
  app: "isaac",
  version: 1,
  note: "Maria Gonzalez, 555-0142, wants $60,000 — “quoted”, ünïcode",
});
const WRONG = /Wrong passphrase, or the file has been changed\. Nothing was restored/;

let envelope: EncryptedBackup;
let text: string;

beforeAll(async () => {
  text = await encryptBackup(PLAIN, PASS);
  envelope = JSON.parse(text) as EncryptedBackup;
});

/** A copy of the envelope with one change, as text the way a file would hold it. */
const changed = (edit: (e: Record<string, unknown>) => void): string => {
  const copy = JSON.parse(text) as Record<string, unknown>;
  edit(copy);
  return JSON.stringify(copy);
};
/** Flips one bit of a base64 field, so the bytes differ and the base64 is still valid. */
const flip = (b64: string): string => {
  const bytes = Buffer.from(b64, "base64");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString("base64");
};

describe("passphrase rules", () => {
  it.each([
    ["", "at least 12"],
    ["short one", "at least 12"],
    ["12345678901", "at least 12"],
    ["x".repeat(1025), "at most 1024"],
    [undefined, "Type a passphrase"],
    [42, "Type a passphrase"],
    [null, "Type a passphrase"],
  ])("refuses %j", (value, message) => {
    expect(passphraseProblem(value)).toContain(message);
  });

  it.each([
    "x".repeat(MIN_PASSPHRASE_LENGTH),
    PASS,
    "  spaces count too  ",
    "pässwörd-ünïcode-ok",
    "x".repeat(1024),
  ])("accepts %j", (value) => {
    expect(passphraseProblem(value)).toBeNull();
  });

  it("counts characters, not bytes: twelve accented letters are enough", () => {
    expect(passphraseProblem("éééééééééééé")).toBeNull();
    expect(passphraseProblem("ééééééééééé")).not.toBeNull();
  });

  it("encryptBackup refuses a weak passphrase before doing any work", async () => {
    await expect(encryptBackup(PLAIN, "short")).rejects.toThrow(/at least 12/);
  });
});

describe("the encrypted file", () => {
  it("is a versioned envelope that holds none of the backup in the clear", () => {
    expect(isEncryptedBackup(envelope)).toBe(true);
    expect(envelope).toMatchObject({
      format: ENCRYPTED_BACKUP_FORMAT,
      version: 1,
      cipher: "aes-256-gcm",
      kdf: { name: "scrypt", N: 131072, r: 8, p: 1 },
    });
    expect(Buffer.from(envelope.kdf.salt, "base64")).toHaveLength(16);
    expect(Buffer.from(envelope.nonce, "base64")).toHaveLength(12);
    expect(Buffer.from(envelope.tag, "base64")).toHaveLength(16);
    for (const secret of ["Maria", "Gonzalez", "555-0142", '"app"', "60,000", PASS])
      expect(text).not.toContain(secret);
  });

  it("uses a fresh salt and nonce every time, so the same backup never encrypts the same way twice", async () => {
    const other = JSON.parse(await encryptBackup(PLAIN, PASS)) as EncryptedBackup;
    expect(other.kdf.salt).not.toBe(envelope.kdf.salt);
    expect(other.nonce).not.toBe(envelope.nonce);
    expect(other.ciphertext).not.toBe(envelope.ciphertext);
  });

  it("round-trips: the right passphrase gives back exactly what went in", async () => {
    expect(JSON.stringify(await decryptBackup(envelope, PASS))).toBe(PLAIN);
    expect(JSON.stringify(await readBackupFile(text, PASS))).toBe(PLAIN);
  });

  it("round-trips a passphrase with unicode and spaces", async () => {
    const odd = "  pässwörd with spaces ✓ ";
    const file = await encryptBackup(PLAIN, odd);
    expect(JSON.stringify(await readBackupFile(file, odd))).toBe(PLAIN);
    await expect(readBackupFile(file, odd.trim())).rejects.toThrow(WRONG);
  });
});

describe("a wrong passphrase or a changed file is refused, and nothing comes back", () => {
  it.each(["wrong passphrase here", PASS.toUpperCase(), `${PASS} `, " "])(
    "wrong passphrase %j",
    async (wrong) => {
      await expect(readBackupFile(text, wrong)).rejects.toThrow(WRONG);
    },
  );

  it.each([
    ["ciphertext", (e: Record<string, unknown>) => (e.ciphertext = flip(e.ciphertext as string))],
    ["tag", (e: Record<string, unknown>) => (e.tag = flip(e.tag as string))],
    ["nonce", (e: Record<string, unknown>) => (e.nonce = flip(e.nonce as string))],
    [
      "salt",
      (e: Record<string, unknown>) => {
        const kdf = e.kdf as Record<string, unknown>;
        kdf.salt = flip(kdf.salt as string);
      },
    ],
    [
      "ciphertext cut short",
      (e: Record<string, unknown>) =>
        (e.ciphertext = Buffer.from(e.ciphertext as string, "base64")
          .subarray(1)
          .toString("base64")),
    ],
    [
      "ciphertext extended",
      (e: Record<string, unknown>) =>
        (e.ciphertext = Buffer.concat([
          Buffer.from(e.ciphertext as string, "base64"),
          Buffer.from("x"),
        ]).toString("base64")),
    ],
    ["empty ciphertext", (e: Record<string, unknown>) => (e.ciphertext = "")],
  ])("tampered %s", async (_name, edit) => {
    await expect(readBackupFile(changed(edit), PASS)).rejects.toThrow(RestoreError);
    await expect(readBackupFile(changed(edit), PASS)).rejects.toThrow(
      /Wrong passphrase|damaged or from a newer version/,
    );
  });

  it("a header change that leaves every byte the same still fails the tag (the header is authenticated)", async () => {
    // A 16-byte salt is 22 base64 characters plus "==", and the last character carries 4 unused bits: flipping one
    // gives another spelling of the SAME salt, so the same key. Only the authenticated header text differs.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const salt = envelope.kdf.salt;
    const respelled = `${salt.slice(0, 21)}${alphabet[alphabet.indexOf(salt[21] ?? "A") ^ 1]}==`;
    expect(respelled).not.toBe(salt);
    expect(Buffer.from(respelled, "base64").equals(Buffer.from(salt, "base64"))).toBe(true);
    const edited = changed((e) => ((e.kdf as Record<string, unknown>).salt = respelled));
    await expect(readBackupFile(edited, PASS)).rejects.toThrow(WRONG);
    // and the untouched file still opens, so the failure above was the header and nothing else
    await expect(readBackupFile(text, PASS)).resolves.toBeDefined();
  });

  it.each([
    ["version", (e: Record<string, unknown>) => (e.version = 2)],
    ["cipher", (e: Record<string, unknown>) => (e.cipher = "aes-128-gcm")],
    [
      "kdf name",
      (e: Record<string, unknown>) => ((e.kdf as Record<string, unknown>).name = "pbkdf2"),
    ],
    [
      "kdf cost raised (memory bomb)",
      (e: Record<string, unknown>) => ((e.kdf as Record<string, unknown>).N = 2 ** 30),
    ],
    [
      "kdf cost lowered (downgrade)",
      (e: Record<string, unknown>) => ((e.kdf as Record<string, unknown>).N = 2),
    ],
    ["kdf r", (e: Record<string, unknown>) => ((e.kdf as Record<string, unknown>).r = 1)],
    ["kdf p", (e: Record<string, unknown>) => ((e.kdf as Record<string, unknown>).p = 99)],
    ["kdf missing", (e: Record<string, unknown>) => delete e.kdf],
    ["tag missing", (e: Record<string, unknown>) => delete e.tag],
    ["tag too short", (e: Record<string, unknown>) => (e.tag = "AAAA")],
    ["nonce too short", (e: Record<string, unknown>) => (e.nonce = "AAAA")],
    [
      "salt not base64",
      (e: Record<string, unknown>) => ((e.kdf as Record<string, unknown>).salt = "!!!"),
    ],
    ["ciphertext not a string", (e: Record<string, unknown>) => (e.ciphertext = 7)],
  ])("refuses a file with a bad %s without deriving a key", async (_name, edit) => {
    const start = Date.now();
    await expect(readBackupFile(changed(edit), PASS)).rejects.toThrow(
      /damaged or from a newer version/,
    );
    // refused by the header check, not by running scrypt (which takes far longer than this)
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("an authentic envelope whose content is not JSON is refused, not parsed", async () => {
    // build a valid envelope around garbage by encrypting garbage
    const garbage = await encryptBackup("this is { not json", PASS);
    await expect(readBackupFile(garbage, PASS)).rejects.toThrow(/damaged/);
  });
});

describe("reading a backup file", () => {
  it("an encrypted file with no passphrase asks for one", async () => {
    await expect(readBackupFile(text)).rejects.toBeInstanceOf(PassphraseRequired);
    await expect(readBackupFile(text, "")).rejects.toBeInstanceOf(PassphraseRequired);
    await expect(readBackupFile(text)).rejects.toThrow(/encrypted.*passphrase/i);
  });

  it("a plain backup is read as it is, whether or not a passphrase is offered", async () => {
    expect(JSON.stringify(await readBackupFile(PLAIN))).toBe(PLAIN);
    expect(JSON.stringify(await readBackupFile(PLAIN, "ignored passphrase"))).toBe(PLAIN);
  });

  it("text that is not JSON is refused in a sentence", async () => {
    await expect(readBackupFile("not json at all")).rejects.toThrow(/not a Selective CRM backup/);
  });

  it("checkBackup refuses an envelope that was never decrypted, and says why", () => {
    expect(() => checkBackup(envelope)).toThrow(/encrypted/);
  });
});
