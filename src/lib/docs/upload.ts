/**
 * The document pipeline: a merchant's upload link, a rep's drag-and-drop and an email attachment all land here.
 * Check the file, hash it, label it, store the bytes, write the row — the database trigger ticks the stip, writes
 * the activity line and re-buckets the merchant.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Db, DbAccess } from "../db";
import { UserError } from "../data/mutations";
import type { ISODate } from "../mca/dates";
import { freshness, type Freshness } from "./freshness";
import { DOC_KINDS, type DocKind, labelFile, labelOf } from "./label";
import { type BlobStore, keyName, safeName } from "./storage";

export const MAX_BYTES = 25 * 1024 * 1024;
export const SESSION_HOURS = 2;
export const MAX_FILES_PER_SESSION = 20;

// ---------- the file check ----------

const EXT_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  webp: "image/webp",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (b: Uint8Array, s: string, at = 0) =>
  startsWith(
    b,
    [...s].map((c) => c.charCodeAt(0)),
    at,
  );

/** Does the content match a type we accept? Returns the type to store the file as. */
function magicType(bytes: Uint8Array): string | null {
  if (ascii(bytes, "%PDF")) return "application/pdf";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (ascii(bytes, "ftyp", 4)) return "image/heic";
  if (ascii(bytes, "RIFF") && ascii(bytes, "WEBP", 8)) return "image/webp";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip"; // xlsx / docx
  return null;
}

function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 2048);
  for (let i = 0; i < n; i++) {
    const c = bytes[i]!;
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) return false;
  }
  return n > 0;
}

export type Sniff = { ok: true; contentType: string } | { ok: false; reason: string };

/**
 * What we accept: PDFs, photos, spreadsheets and Word files whose bytes match their extension. Nothing executable,
 * nothing that a browser would run (HTML, SVG, scripts). This is a type check, not antivirus — see `scanPending`.
 */
export function sniff(bytes: Uint8Array, declaredType: string, filename: string): Sniff {
  if (bytes.length === 0) return { ok: false, reason: "The file is empty" };
  if (bytes.length > MAX_BYTES) return { ok: false, reason: "The file is over 25 MB" };
  const ext = (filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "").trim();
  const wanted = EXT_TYPE[ext];
  if (!wanted)
    return {
      ok: false,
      reason: `.${ext || "?"} files are not accepted. Send a PDF, photo, spreadsheet or Word file`,
    };
  const magic = magicType(bytes);
  if (ext === "csv") {
    return looksLikeText(bytes)
      ? { ok: true, contentType: "text/csv" }
      : { ok: false, reason: "That is not a CSV file" };
  }
  if (ext === "xlsx" || ext === "docx") {
    return magic === "application/zip"
      ? { ok: true, contentType: wanted }
      : { ok: false, reason: `That is not a real .${ext} file` };
  }
  if (ext === "heic" || ext === "heif") {
    return magic === "image/heic"
      ? { ok: true, contentType: wanted }
      : { ok: false, reason: "That is not a HEIC photo" };
  }
  if (magic !== wanted) return { ok: false, reason: `The file does not look like a .${ext}` };
  void declaredType; // the browser's guess is not trusted; the bytes decide
  return { ok: true, contentType: wanted };
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const newToken = (): string => randomBytes(24).toString("hex");

// ---------- what we are asking the merchant for ----------

export interface Wanted {
  kind: DocKind;
  period: ISODate | null;
  label: string;
}

/** Open required stips plus the statement months still expected that are not on file. */
export async function wantedFor(q: Db, clientId: string, today: ISODate): Promise<Wanted[]> {
  const { rows } = await q.query<{ kind: DocKind; period: string | null }>(
    `select kind, period::text as period from stips where client_id = $1 and required and received_at is null
      order by case kind when 'signed_application' then 0 when 'bank_statement' then 1 else 2 end, period`,
    [clientId],
  );
  const out: Wanted[] = rows.map((r) => ({
    kind: r.kind,
    period: r.period,
    label: labelOf(r.kind, r.period),
  }));
  const fresh = await clientFreshness(q, clientId, today);
  for (const p of fresh.missing) {
    if (!out.some((w) => w.kind === "bank_statement" && w.period === p))
      out.push({ kind: "bank_statement", period: p, label: labelOf("bank_statement", p) });
  }
  return out;
}

export async function clientFreshness(q: Db, clientId: string, today: ISODate): Promise<Freshness> {
  const { rows } = await q.query<{ p: string }>(
    `select distinct period::text as p from (
       select period from documents where client_id = $1 and kind = 'bank_statement' and period is not null and deleted_at is null
       union select period from stips where client_id = $1 and kind = 'bank_statement' and period is not null and received_at is not null
     ) x`,
    [clientId],
  );
  return freshness(
    rows.map((r) => r.p),
    today,
  );
}

// ---------- upload sessions ----------

export interface UploadSession {
  id: string;
  token: string;
  client_id: string;
  purpose: string;
  wanted: Wanted[];
  expires_at: string;
  max_files: number;
  files_received: number;
  business_name: string;
  contact_name: string;
  rep_name: string;
  shop_name: string;
}

export interface MintArgs {
  clientId: string;
  purpose?: "documents" | "statements" | "stips" | "application" | "offer";
  wanted?: Wanted[];
  createdBy?: string | null;
  hours?: number;
}

/** A two-hour upload session. Runs as the rep (RLS) or as the system for the merchant's own link. */
export async function mintUploadSession(
  q: Db,
  a: MintArgs,
): Promise<{ token: string; expiresAt: string }> {
  const token = newToken();
  const { rows } = await q.query<{ expires_at: string }>(
    `insert into upload_sessions (token, client_id, purpose, wanted, created_by, expires_at)
     values ($1, $2, $3, $4::jsonb, $5, now() + ($6 || ' hours')::interval) returning expires_at::text`,
    [
      token,
      a.clientId,
      a.purpose ?? "documents",
      JSON.stringify(a.wanted ?? []),
      a.createdBy ?? null,
      String(a.hours ?? SESSION_HOURS),
    ],
  );
  return { token, expiresAt: rows[0]?.expires_at ?? "" };
}

const SESSION_SQL = `select s.id, s.token, s.client_id, s.purpose, s.wanted, s.expires_at::text as expires_at, s.max_files, s.files_received,
            c.business_name, c.contact_name, u.name as rep_name, (select shop_name from shop_settings) as shop_name
       from upload_sessions s join clients c on c.id = s.client_id join app_users u on u.id = c.user_id
      where s.token = $1 and s.expires_at > now()
        and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)`;

async function loadSession(q: Db, token: string): Promise<UploadSession | null> {
  const { rows } = await q.query<UploadSession>(SESSION_SQL, [token]);
  return rows[0] ?? null;
}

/**
 * What /upload/<token> shows. The token is a live session, or the merchant's permanent link (then a session is minted
 * on the spot, asking for whatever is still missing). Null when the token means nothing.
 */
export async function openUploadPage(
  db: DbAccess,
  token: string,
  today: ISODate,
): Promise<UploadSession | null> {
  if (!/^[A-Za-z0-9]{20,80}$/.test(token)) return null;
  return db.withSystem(async (q) => {
    const live = await loadSession(q, token);
    if (live) return live;
    const { rows } = await q.query<{ id: string }>(
      `select c.id from clients c where c.upload_token = $1
         and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)`,
      [token],
    );
    const clientId = rows[0]?.id;
    if (!clientId) return null;
    // the same visitor refreshing (or a scripted loop) keeps one session; max_files means something again
    // an offer page's session asks for that offer's documents only: the everyday link never picks it up
    const open = await q.query<{ token: string }>(
      `select token from upload_sessions where client_id = $1 and created_by is null and expires_at > now()
          and purpose <> 'offer'
        order by created_at desc limit 1`,
      [clientId],
    );
    if (open.rows[0]) return loadSession(q, open.rows[0].token);
    const wanted = await wantedFor(q, clientId, today);
    const minted = await mintUploadSession(q, { clientId, wanted, createdBy: null });
    return loadSession(q, minted.token);
  });
}

/**
 * A new permanent link for the merchant (P2-29): the token in every past email stops resolving, and the sessions the
 * old link opened die with it. The next email carries the new one.
 */
export async function rotateUploadToken(q: Db, clientId: string): Promise<void> {
  const r = await q.query("update clients set upload_token = default where id = $1", [clientId]);
  if (r.rowCount === 0) throw new UserError("That merchant isn't in your view");
  await q.query(
    "update upload_sessions set expires_at = now() where client_id = $1 and created_by is null and expires_at > now()",
    [clientId],
  );
  await q.query(
    "insert into activities (user_id, client_id, kind, body) select user_id, id, 'system', 'Upload link reset. The old link no longer works' from clients where id = $1",
    [clientId],
  );
}

/** True when the token names a live upload session (the route checks this before reading a body); never mints. */
export async function uploadSessionLive(db: DbAccess, token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9]{20,80}$/.test(token)) return false;
  return db.withSystem(async (q) => (await loadSession(q, token)) !== null);
}

// ---------- accepting a file ----------

export interface Accepted {
  documentId: string;
  kind: DocKind;
  period: ISODate | null;
  label: string;
  confidence: number;
  duplicate: boolean;
}

interface FileIn {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

async function writeDocument(
  q: Db,
  store: BlobStore,
  a: FileIn & {
    clientId: string;
    userId: string;
    source: "upload_link" | "staff" | "email" | "sheet";
    uploadedBy: string | null;
    kind?: DocKind;
    /** The merchant picked the slot (the offer page): a label to check, not one a person set. */
    kindByMerchant?: boolean;
    period?: ISODate | null;
    scan: "pending" | "clean";
    today: ISODate;
  },
): Promise<Accepted> {
  const s = sniff(a.bytes, a.contentType, a.filename);
  if (!s.ok) throw new UserError(s.reason);
  const hash = sha256Hex(a.bytes);
  const dup = await q.query<{
    id: string;
    kind: DocKind;
    period: string | null;
    label_confidence: string;
  }>(
    "select id, kind, period::text as period, label_confidence from documents where client_id = $1 and sha256 = $2 and deleted_at is null",
    [a.clientId, hash],
  );
  const d0 = dup.rows[0];
  if (d0 && a.kind && d0.kind !== a.kind) {
    // the same file again, sent for a different slot: an unsorted one takes the slot's label, anything else is a
    // different document the merchant has not sent yet (one PDF of a license and a check cannot be both)
    if (d0.kind !== "other")
      throw new UserError(
        `That file is already here as your ${labelOf(d0.kind, d0.period).toLowerCase()}. Send the ${labelOf(a.kind, null).toLowerCase()} as its own file`,
      );
    await q.query("select relabel_document($1, $2, null)", [d0.id, a.kind]);
    await q.query(
      `update documents set label_by = 'rule', label_confidence = 0.7, label_reason = 'chosen by the merchant on the offer page'
        where id = $1`,
      [d0.id],
    );
    return {
      documentId: d0.id,
      kind: a.kind,
      period: null,
      label: labelOf(a.kind, null),
      confidence: 0.7,
      duplicate: true,
    };
  }
  if (d0) {
    return {
      documentId: d0.id,
      kind: d0.kind,
      period: d0.period,
      label: labelOf(d0.kind, d0.period),
      confidence: Number(d0.label_confidence),
      duplicate: true,
    };
  }
  const guess = labelFile(a.filename, s.contentType, a.today);
  const kind = a.kind ?? guess.kind;
  const period = a.kind
    ? a.kind === "bank_statement"
      ? (a.period ?? null)
      : null
    : kind === "bank_statement"
      ? guess.period
      : null;
  // a slot the merchant chose is a rule label under the review line (the documents card asks a person to check it)
  const labelBy = a.kind && !a.kindByMerchant ? "human" : "rule";
  const confidence = a.kind ? (a.kindByMerchant ? 0.7 : 1) : guess.confidence;
  const { rows } = await q.query<{ id: string }>("select gen_random_uuid() as id");
  const id = rows[0]!.id;
  const key = `${a.clientId}/${id}-${keyName(a.filename)}`;
  await store.put(key, a.bytes, s.contentType);
  try {
    await q.query(
      `insert into documents (id, user_id, client_id, kind, period, filename, content_type, size_bytes, sha256, storage_key,
                              source, uploaded_by, label_by, label_confidence, label_reason, scan_status, scanned_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, case when $16 = 'clean' then now() end)`,
      [
        id,
        a.userId,
        a.clientId,
        kind,
        period,
        safeName(a.filename),
        s.contentType,
        a.bytes.length,
        hash,
        key,
        a.source,
        a.uploadedBy,
        labelBy,
        confidence,
        a.kind
          ? a.kindByMerchant
            ? "chosen by the merchant on the offer page"
            : "set on upload"
          : guess.reason,
        a.scan,
      ],
    );
  } catch (e) {
    await store.delete(key).catch(() => undefined);
    throw e;
  }
  return {
    documentId: id,
    kind,
    period,
    label: labelOf(kind, period),
    confidence,
    duplicate: false,
  };
}

/** The merchant's upload. System connection: they have no account. The row belongs to their rep. */
export async function acceptUpload(
  db: DbAccess,
  store: BlobStore,
  a: FileIn & { token: string; today: ISODate; ip?: string; kind?: DocKind },
): Promise<Accepted> {
  // The file cap is enforced by a short reservation: one conditional update takes a slot, commits, and releases the row
  // lock. The blob write then runs outside any lock, so parallel uploads on one link (several tabs, retries, slow
  // storage) do not queue behind each other, and several at once still cannot pass max_files.
  const s = await db.withSystem(async (q) => {
    const live = await loadSession(q, a.token);
    if (!live) throw new UserError("This upload link has expired. Ask your rep for a fresh one.");
    const { rowCount } = await q.query(
      `update upload_sessions set files_received = files_received + 1, last_used_at = now()
        where id = $1 and files_received < max_files`,
      [live.id],
    );
    if (!rowCount)
      throw new UserError(
        "This link has taken all the files it can. Ask your rep for a fresh one.",
      );
    return live;
  });
  const release = () =>
    db
      .withSystem((q) =>
        q.query(
          "update upload_sessions set files_received = greatest(files_received - 1, 0) where id = $1",
          [s.id],
        ),
      )
      .catch((err) => console.error("upload slot not released:", err));
  let out: Accepted;
  try {
    out = await db.withSystem(async (q) => {
      const { rows } = await q.query<{ user_id: string }>(
        "select user_id from clients where id = $1",
        [s.client_id],
      );
      const userId = rows[0]?.user_id;
      if (!userId) throw new UserError("This upload link has expired.");
      return writeDocument(q, store, {
        ...a,
        // only an offer page's slots name what a file is; every other link reads it from the file
        kind: s.purpose === "offer" ? a.kind : undefined,
        kindByMerchant: true,
        clientId: s.client_id,
        userId,
        source: "upload_link",
        uploadedBy: null,
        scan: "pending",
      });
    });
  } catch (err) {
    await release();
    throw err;
  }
  // a file already on record is not a new file: give the slot back
  if (out.duplicate) await release();
  return out;
}

/**
 * An attachment on an email a merchant sent: the statements they forward.
 * System connection (the sync has no user); the row belongs to the merchant's rep; it waits for the scan like any
 * outside file. Files that are not documents (signatures, logos, tiny images) are skipped, not errors.
 */
export async function fileEmailAttachment(
  db: DbAccess,
  store: BlobStore,
  a: FileIn & { clientId: string; today: ISODate },
): Promise<Accepted | null> {
  if (a.bytes.length < 2048 && /^image\//.test(a.contentType)) return null; // an email signature logo
  if (!sniff(a.bytes, a.contentType, a.filename).ok) return null;
  return db.withSystem(async (q) => {
    const { rows } = await q.query<{ user_id: string }>(
      "select user_id from clients where id = $1",
      [a.clientId],
    );
    const userId = rows[0]?.user_id;
    if (!userId) return null;
    return writeDocument(q, store, {
      ...a,
      userId,
      source: "email",
      uploadedBy: null,
      scan: "pending",
    });
  });
}

/** A rep's upload (drag and drop), or an attachment the inbox filed. Runs as the user under RLS. */
export async function addDocument(
  q: Db,
  store: BlobStore,
  a: FileIn & {
    clientId: string;
    kind?: DocKind;
    period?: ISODate | null;
    source?: "staff" | "email" | "sheet";
    uploadedBy: string;
    today: ISODate;
  },
): Promise<Accepted> {
  if (a.kind && !DOC_KINDS.includes(a.kind)) throw new UserError("Unknown document type");
  const { rows } = await q.query<{ user_id: string }>("select user_id from clients where id = $1", [
    a.clientId,
  ]);
  const userId = rows[0]?.user_id;
  if (!userId) throw new UserError("Merchant not found");
  return writeDocument(q, store, {
    ...a,
    userId,
    source: a.source ?? "staff",
    uploadedBy: a.uploadedBy,
    scan: "clean",
  });
}

/**
 * A document the app made itself (the signed application PDF): filed as a merchant upload, already clean because
 * no outside bytes were involved. System connection; the row belongs to the merchant's rep.
 */
export async function fileGeneratedDocument(
  q: Db,
  store: BlobStore,
  a: {
    clientId: string;
    kind: DocKind;
    filename: string;
    bytes: Uint8Array;
    today: ISODate;
  },
): Promise<Accepted> {
  const { rows } = await q.query<{ user_id: string }>("select user_id from clients where id = $1", [
    a.clientId,
  ]);
  const userId = rows[0]?.user_id;
  if (!userId) throw new UserError("Merchant not found");
  return writeDocument(q, store, {
    filename: a.filename,
    contentType: "application/pdf",
    bytes: a.bytes,
    clientId: a.clientId,
    userId,
    kind: a.kind,
    source: "upload_link",
    uploadedBy: null,
    scan: "clean",
    today: a.today,
  });
}

// ---------- reading ----------

export interface DocumentRow {
  id: string;
  client_id: string;
  kind: DocKind;
  period: ISODate | null;
  label: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  source: string;
  uploaded_by_name: string | null;
  label_by: string;
  label_confidence: number;
  label_reason: string;
  scan_status: string;
  created_at: string;
}

export async function listDocuments(q: Db, clientId: string): Promise<DocumentRow[]> {
  const { rows } = await q.query<{ j: DocumentRow }>(
    `select to_jsonb(x) as j from (
       select d.id, d.client_id, d.kind, d.period::text as period, app.document_label(d.kind, d.period) as label,
              d.filename, d.content_type, d.size_bytes, d.source, u.name as uploaded_by_name, d.label_by, d.label_confidence,
              d.label_reason, d.scan_status, d.created_at
         from documents d left join app_users u on u.id = d.uploaded_by
        where d.client_id = $1 and d.deleted_at is null
        order by d.kind = 'bank_statement' desc, d.period desc nulls last, d.created_at desc
     ) x`,
    [clientId],
  );
  return rows.map((r) => ({
    ...r.j,
    size_bytes: Number(r.j.size_bytes),
    label_confidence: Number(r.j.label_confidence),
  }));
}

export interface OpenedDocument {
  id: string;
  filename: string;
  content_type: string;
  storage_key: string;
  scan_status: string;
}

/** The row behind a download, under RLS. Throws a UserError when the file is not clean yet. */
export async function openDocument(q: Db, documentId: string): Promise<OpenedDocument> {
  const { rows } = await q.query<OpenedDocument>(
    `select d.id, d.filename, d.content_type, d.storage_key, d.scan_status
       from documents d where d.id = $1 and d.deleted_at is null`,
    [documentId],
  );
  const d = rows[0];
  if (!d) throw new UserError("Document not found");
  if (d.scan_status !== "clean")
    throw new UserError(
      d.scan_status === "pending"
        ? "This file is still being checked. Try again in a minute."
        : "This file was rejected by the scan and cannot be opened.",
    );
  return d;
}

export async function relabelDocument(
  q: Db,
  documentId: string,
  kind: DocKind,
  period: ISODate | null,
): Promise<void> {
  if (!DOC_KINDS.includes(kind)) throw new UserError("Unknown document type");
  await q.query("select relabel_document($1, $2, $3)", [
    documentId,
    kind,
    kind === "bank_statement" ? period : null,
  ]);
}

export async function deleteDocument(
  q: Db,
  store: BlobStore,
  documentId: string,
  by: string,
): Promise<void> {
  const { rows } = await q.query<{ storage_key: string }>(
    "update documents set deleted_at = now(), deleted_by = $2 where id = $1 and deleted_at is null returning storage_key",
    [documentId, by],
  );
  const key = rows[0]?.storage_key;
  if (!key) throw new UserError("Document not found");
  await store.delete(key).catch(() => undefined);
}

// ---------- the scan ----------

export type Scanner = (
  bytes: Uint8Array,
  contentType: string,
  filename: string,
) => Promise<{ clean: boolean; note: string }>;

/**
 * The built-in scanner re-checks the bytes against the extension. It is not antivirus. When the shop adds one
 * (ClamAV, VirusTotal, the host's scanner), it slots in here and nothing else changes.
 */
export const builtinScanner: Scanner = async (bytes, contentType, filename) => {
  const s = sniff(bytes, contentType, filename);
  return s.ok ? { clean: true, note: "type check passed" } : { clean: false, note: s.reason };
};

/** Pending merchant uploads, oldest first. Runs from the outbox cron so a file is openable within minutes. */
export async function scanPending(
  db: DbAccess,
  store: BlobStore,
  scanner: Scanner = builtinScanner,
  max = 50,
): Promise<{ scanned: number; clean: number; rejected: number; errors: number }> {
  return db.withSystem(async (q) => {
    const { rows } = await q.query<{
      id: string;
      storage_key: string;
      content_type: string;
      filename: string;
    }>(
      "select id, storage_key, content_type, filename from documents where scan_status = 'pending' and deleted_at is null order by created_at limit $1",
      [max],
    );
    let clean = 0;
    let rejected = 0;
    let errors = 0;
    for (const d of rows) {
      let verdict: { clean: boolean; note: string };
      try {
        const stored = await store.get(d.storage_key);
        verdict = stored
          ? await scanner(stored.bytes, d.content_type, d.filename)
          : { clean: false, note: "bytes missing from storage" };
      } catch (err) {
        // a storage hiccup on one file must not undo the verdicts already written for the others: it stays pending
        // and the next run tries it again
        errors++;
        console.error("document scan:", d.id, err instanceof Error ? err.message : err);
        continue;
      }
      await q.query(
        "update documents set scan_status = $2, scan_note = $3, scanned_at = now() where id = $1",
        [d.id, verdict.clean ? "clean" : "rejected", verdict.note],
      );
      if (verdict.clean) clean++;
      else {
        rejected++;
        // a document an accepted offer was waiting for turned out not to be one: the rep has to ask again
        await q.query(
          `insert into user_alerts (user_id, kind, client_id, title, body, href, dedupe_key)
           select c.user_id, 'offer_doc_rejected', c.id, c.business_name || ': a document failed its check',
                  d.filename || ' could not be read safely. Ask for it again before funding.', '/clients/' || c.id,
                  'offer_doc_rejected:' || d.id
             from documents d join clients c on c.id = d.client_id
            where d.id = $1 and exists (select 1 from merchant_offers o
                                         where o.client_id = d.client_id and o.status = 'accepted'
                                           and d.kind = any(o.docs))
           on conflict do nothing`,
          [d.id],
        );
      }
    }
    return { scanned: rows.length - errors, clean, rejected, errors };
  });
}
