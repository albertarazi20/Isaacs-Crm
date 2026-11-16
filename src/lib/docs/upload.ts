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
import { type BlobStore, safeName } from "./storage";

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

/** Open required stips plus the statement months lenders expect that are not on file. */
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
  deal_id: string | null;
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
  dealId?: string | null;
  purpose?: "documents" | "statements" | "stips" | "application" | "renewal";
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
    `insert into upload_sessions (token, client_id, deal_id, purpose, wanted, created_by, expires_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, now() + ($7 || ' hours')::interval) returning expires_at::text`,
    [
      token,
      a.clientId,
      a.dealId ?? null,
      a.purpose ?? "documents",
      JSON.stringify(a.wanted ?? []),
      a.createdBy ?? null,
      String(a.hours ?? SESSION_HOURS),
    ],
  );
  return { token, expiresAt: rows[0]?.expires_at ?? "" };
}

async function loadSession(q: Db, token: string): Promise<UploadSession | null> {
  const { rows } = await q.query<UploadSession>(
    `select s.id, s.token, s.client_id, s.deal_id, s.purpose, s.wanted, s.expires_at::text as expires_at, s.max_files, s.files_received,
            c.business_name, c.contact_name, u.name as rep_name, (select shop_name from shop_settings) as shop_name
       from upload_sessions s join clients c on c.id = s.client_id join app_users u on u.id = c.user_id
      where s.token = $1 and s.expires_at > now()
        and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)`,
    [token],
  );
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
    const open = await q.query<{ token: string }>(
      `select token from upload_sessions where client_id = $1 and created_by is null and expires_at > now()
        order by created_at desc limit 1`,
      [clientId],
    );
    if (open.rows[0]) return loadSession(q, open.rows[0].token);
    const wanted = await wantedFor(q, clientId, today);
    const minted = await mintUploadSession(q, { clientId, wanted, createdBy: null });
    return loadSession(q, minted.token);
  });
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
    dealId: string | null;
    source: "upload_link" | "staff" | "email" | "sheet";
    uploadedBy: string | null;
    kind?: DocKind;
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
  const labelBy = a.kind ? "human" : "rule";
  const confidence = a.kind ? 1 : guess.confidence;
  const { rows } = await q.query<{ id: string }>("select gen_random_uuid() as id");
  const id = rows[0]!.id;
  const key = `${a.clientId}/${id}-${safeName(a.filename)}`;
  await store.put(key, a.bytes, s.contentType);
  try {
    await q.query(
      `insert into documents (id, user_id, client_id, deal_id, kind, period, filename, content_type, size_bytes, sha256, storage_key,
                              source, uploaded_by, label_by, label_confidence, label_reason, scan_status, scanned_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, case when $17 = 'clean' then now() end)`,
      [
        id,
        a.userId,
        a.clientId,
        a.dealId,
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
        a.kind ? "set on upload" : guess.reason,
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
  a: FileIn & { token: string; today: ISODate; ip?: string },
): Promise<Accepted> {
  return db.withSystem(async (q) => {
    const s = await loadSession(q, a.token);
    if (!s) throw new UserError("This upload link has expired. Ask your rep for a fresh one.");
    if (s.files_received >= s.max_files)
      throw new UserError(
        "This link has taken all the files it can. Ask your rep for a fresh one.",
      );
    const { rows } = await q.query<{ user_id: string }>(
      "select user_id from clients where id = $1",
      [s.client_id],
    );
    const userId = rows[0]?.user_id;
    if (!userId) throw new UserError("This upload link has expired.");
    const out = await writeDocument(q, store, {
      ...a,
      clientId: s.client_id,
      userId,
      dealId: s.deal_id,
      source: "upload_link",
      uploadedBy: null,
      scan: "pending",
    });
    if (!out.duplicate) {
      await q.query(
        "update upload_sessions set files_received = files_received + 1, last_used_at = now() where id = $1",
        [s.id],
      );
    }
    return out;
  });
}

/**
 * An attachment on an email the inbox matched to a merchant: statements a merchant forwards, contracts a lender sends.
 * System connection (the sync has no user); the row belongs to the merchant's rep; it waits for the scan like any
 * outside file. Files that are not documents (signatures, logos, tiny images) are skipped, not errors.
 */
export async function fileEmailAttachment(
  db: DbAccess,
  store: BlobStore,
  a: FileIn & { clientId: string; dealId?: string | null; today: ISODate },
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
      dealId: a.dealId ?? null,
      source: "email",
      uploadedBy: null,
      scan: "pending",
    });
  });
}

/** A rep's or ops' upload (drag and drop), or an attachment the inbox filed. Runs as the user under RLS. */
export async function addDocument(
  q: Db,
  store: BlobStore,
  a: FileIn & {
    clientId: string;
    dealId?: string | null;
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
    dealId: a.dealId ?? null,
    source: a.source ?? "staff",
    uploadedBy: a.uploadedBy,
    scan: "clean",
  });
}

// ---------- reading ----------

export interface DocumentRow {
  id: string;
  client_id: string;
  deal_id: string | null;
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
  views: number;
}

export async function listDocuments(q: Db, clientId: string): Promise<DocumentRow[]> {
  const { rows } = await q.query<{ j: DocumentRow }>(
    `select to_jsonb(x) as j from (
       select d.id, d.client_id, d.deal_id, d.kind, d.period::text as period, app.document_label(d.kind, d.period) as label,
              d.filename, d.content_type, d.size_bytes, d.source, u.name as uploaded_by_name, d.label_by, d.label_confidence,
              d.label_reason, d.scan_status, d.created_at,
              (select count(*)::int from document_views v where v.document_id = d.id and v.action in ('view', 'download', 'lender_download')) as views
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

export interface ViewMeta {
  ip?: string;
  userAgent?: string;
  linkId?: string | null;
  lenderId?: string | null;
}

export async function recordView(
  q: Db,
  documentId: string,
  action: "view" | "download" | "link_minted" | "lender_download" | "relabel" | "delete",
  viewerUserId: string | null,
  meta: ViewMeta = {},
): Promise<void> {
  await q.query(
    `insert into document_views (document_id, action, viewer_user_id, link_id, lender_id, ip, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      documentId,
      action,
      viewerUserId,
      meta.linkId ?? null,
      meta.lenderId ?? null,
      (meta.ip ?? "").slice(0, 64),
      (meta.userAgent ?? "").slice(0, 300),
    ],
  );
}

export interface OpenedDocument {
  id: string;
  filename: string;
  content_type: string;
  storage_key: string;
  scan_status: string;
  business_name: string;
}

/** The row behind a download, under RLS. Throws a UserError when the file is not clean yet. */
export async function openDocument(q: Db, documentId: string): Promise<OpenedDocument> {
  const { rows } = await q.query<OpenedDocument>(
    `select d.id, d.filename, d.content_type, d.storage_key, d.scan_status, c.business_name
       from documents d join clients c on c.id = d.client_id where d.id = $1 and d.deleted_at is null`,
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
  by: string,
): Promise<void> {
  if (!DOC_KINDS.includes(kind)) throw new UserError("Unknown document type");
  await q.query("select relabel_document($1, $2, $3)", [
    documentId,
    kind,
    kind === "bank_statement" ? period : null,
  ]);
  await recordView(q, documentId, "relabel", by);
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
  await recordView(q, documentId, "delete", by);
  await store.delete(key).catch(() => undefined);
}

// ---------- expiring links ----------

export async function mintDownloadLink(
  q: Db,
  a: {
    documentId: string;
    createdBy: string;
    lenderId?: string | null;
    watermark: string;
    minutes?: number;
    maxDownloads?: number;
  },
): Promise<{ token: string; expiresAt: string }> {
  await openDocument(q, a.documentId); // visible, and clean
  const token = newToken();
  const { rows } = await q.query<{ id: string; expires_at: string }>(
    `insert into document_links (token, document_id, created_by, lender_id, watermark, expires_at, max_downloads)
     values ($1, $2, $3, $4, $5, now() + ($6 || ' minutes')::interval, $7) returning id, expires_at::text`,
    [
      token,
      a.documentId,
      a.createdBy,
      a.lenderId ?? null,
      a.watermark.slice(0, 120),
      String(a.minutes ?? 120),
      a.maxDownloads ?? 5,
    ],
  );
  await recordView(q, a.documentId, "link_minted", a.createdBy, {
    linkId: rows[0]?.id,
    lenderId: a.lenderId ?? null,
  });
  return { token, expiresAt: rows[0]?.expires_at ?? "" };
}

export interface ResolvedLink {
  linkId: string;
  lenderId: string | null;
  watermark: string;
  document: OpenedDocument;
}

/** The outside world's download. System connection; counts the download; null when the link is dead. */
export async function resolveDownloadLink(
  db: DbAccess,
  token: string,
  meta: ViewMeta = {},
): Promise<ResolvedLink | null> {
  if (!/^[A-Za-z0-9]{20,80}$/.test(token)) return null;
  return db.withSystem(async (q) => {
    const { rows } = await q.query<{
      id: string;
      document_id: string;
      lender_id: string | null;
      watermark: string;
    }>(
      `update document_links set downloads = downloads + 1
        where token = $1 and expires_at > now() and revoked_at is null and downloads < max_downloads
        returning id, document_id, lender_id, watermark`,
      [token],
    );
    const l = rows[0];
    if (!l) return null;
    const document = await openDocument(q, l.document_id);
    await recordView(q, document.id, "lender_download", null, {
      ...meta,
      linkId: l.id,
      lenderId: l.lender_id,
    });
    return { linkId: l.id, lenderId: l.lender_id, watermark: l.watermark, document };
  });
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
): Promise<{ scanned: number; clean: number; rejected: number }> {
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
    for (const d of rows) {
      const stored = await store.get(d.storage_key);
      const verdict = stored
        ? await scanner(stored.bytes, d.content_type, d.filename)
        : { clean: false, note: "bytes missing from storage" };
      await q.query(
        "update documents set scan_status = $2, scan_note = $3, scanned_at = now() where id = $1",
        [d.id, verdict.clean ? "clean" : "rejected", verdict.note],
      );
      if (verdict.clean) clean++;
      else rejected++;
    }
    return { scanned: rows.length, clean, rejected };
  });
}
