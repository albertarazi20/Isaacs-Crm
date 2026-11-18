"use client";

import { useState, type FormEvent } from "react";
import { buttonClass, Button, Field, Input } from "@/components/ui";
import { ICON, Icon, SettingRow } from "./primitives";

/** Keep in step with MIN_PASSPHRASE_LENGTH in src/lib/export/backupCrypto.ts (server-only code, so not imported). */
const MIN_LENGTH = 12;

/**
 * The full backup. The first choice is an encrypted file: the manager types a passphrase and the server encrypts the
 * backup with it. The passphrase goes in a POST body, never a URL, and is never stored, so a lost one cannot be
 * recovered. The plain download is a separate, plainly worded choice.
 */
export function BackupRow() {
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const tooShort = [...passphrase.normalize("NFKC")].length < MIN_LENGTH;
  const mismatch = again.length > 0 && again !== passphrase;
  const ready = !tooShort && again === passphrase && !busy;

  async function download(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/export/backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      if (!res.ok) {
        setError((await res.text()) || "The backup could not be made. Try again.");
        return;
      }
      const name =
        /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ??
        "isaac-backup.enc.json";
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setSaved(name);
      setPassphrase("");
      setAgain("");
    } catch {
      setError("The backup could not be made. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingRow
      label="Full backup"
      hint="Merchants, notes, timers and stips in one file. No passwords, Gmail access or upload and application links. Locked with a passphrase, only you can open it."
    >
      <form onSubmit={download} className="flex w-full max-w-sm flex-col gap-3">
        <Field
          label="Passphrase"
          hint={`At least ${MIN_LENGTH} characters. A few ordinary words works well.`}
        >
          <Input
            type="password"
            autoComplete="new-password"
            minLength={MIN_LENGTH}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </Field>
        <Field label="Type it again">
          <Input
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            aria-invalid={mismatch}
          />
        </Field>
        {mismatch ? (
          <p role="alert" className="text-xs text-bad">
            The two passphrases are not the same.
          </p>
        ) : null}
        <p className="text-xs text-warn">
          If you lose this passphrase the backup can never be opened. It is not stored anywhere and
          nobody can recover it. Keep it somewhere safe, apart from the file.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="secondary" size="sm" disabled={!ready}>
            <Icon d={ICON.download} className="size-3.5" />
            {busy ? "Making the backup..." : "Download encrypted backup"}
          </Button>
          <a
            href="/api/export/backup"
            download
            aria-label="Download a full backup without encryption (.json)"
            className={buttonClass("ghost", "sm")}
          >
            Download without encryption
          </a>
        </div>
        <p className="text-xs text-muted">
          Without encryption, anyone who finds the file can read every merchant&apos;s name, phone
          number and funding terms.
        </p>
        {error ? (
          <p role="alert" className="text-xs text-bad">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="text-xs text-good">
            Saved {saved}. Keep the passphrase safe.
          </p>
        ) : null}
      </form>
    </SettingRow>
  );
}
