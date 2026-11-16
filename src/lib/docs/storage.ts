/**
 * Where document bytes live. Never the database, never git (CLAUDE.md). Local disk in development; Supabase Storage
 * (a private bucket, service key, server-side only) in production. Keys are `<clientId>/<documentId>-<name>`.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export interface Stored {
  bytes: Uint8Array;
  contentType: string;
}

export interface BlobStore {
  readonly kind: "local" | "supabase";
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Stored | null>;
  delete(key: string): Promise<void>;
}

/** A copy backed by a plain ArrayBuffer: what fetch and Response accept as a body. */
export const asBody = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

const KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,300}$/;
export function assertKey(key: string): string {
  if (!KEY.test(key) || key.includes("..") || key.includes("//"))
    throw new Error(`bad storage key: ${key}`);
  return key;
}

/** A file name that is safe in a key and a Content-Disposition header. */
export function safeName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "file";
  const cleaned = base
    .replace(/["']/g, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned.replace(/^[._-]+/, "") || "file";
}

export class LocalStore implements BlobStore {
  readonly kind = "local" as const;
  constructor(private readonly root: string) {}
  private path(key: string): string {
    const p = resolve(this.root, assertKey(key));
    if (!p.startsWith(resolve(this.root) + sep)) throw new Error("key escapes the store");
    return p;
  }
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
    await writeFile(`${p}.type`, contentType);
  }
  async get(key: string): Promise<Stored | null> {
    const p = this.path(key);
    try {
      const [bytes, type] = await Promise.all([
        readFile(p),
        readFile(`${p}.type`, "utf8").catch(() => "application/octet-stream"),
      ]);
      return { bytes: new Uint8Array(bytes), contentType: type };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async delete(key: string): Promise<void> {
    const p = this.path(key);
    await rm(p, { force: true });
    await rm(`${p}.type`, { force: true });
  }
}

/** Supabase Storage over its REST API: no SDK, three calls. The service key never leaves the server. */
export class SupabaseStore implements BlobStore {
  readonly kind = "supabase" as const;
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly bucket: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private endpoint(key: string): string {
    return `${this.url.replace(/\/+$/, "")}/storage/v1/object/${encodeURIComponent(this.bucket)}/${assertKey(
      key,
    )
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
  }
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey, ...extra };
  }
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const r = await this.fetchImpl(this.endpoint(key), {
      method: "POST",
      headers: this.headers({ "content-type": contentType, "x-upsert": "true" }),
      body: asBody(bytes),
    });
    if (!r.ok) throw new Error(`storage put failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  async get(key: string): Promise<Stored | null> {
    const r = await this.fetchImpl(this.endpoint(key), { headers: this.headers() });
    if (r.status === 404 || r.status === 400) return null;
    if (!r.ok) throw new Error(`storage get failed: ${r.status}`);
    return {
      bytes: new Uint8Array(await r.arrayBuffer()),
      contentType: r.headers.get("content-type") ?? "application/octet-stream",
    };
  }
  async delete(key: string): Promise<void> {
    const r = await this.fetchImpl(this.endpoint(key), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!r.ok && r.status !== 404) throw new Error(`storage delete failed: ${r.status}`);
  }
}

let cached: BlobStore | undefined;

/** Supabase when its URL and service key are set; otherwise `.data/docs` next to the app (gitignored). */
export function storeFromEnv(e: {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  DOCS_BUCKET?: string;
  DOCS_DIR?: string;
}): BlobStore {
  if (e.SUPABASE_URL && e.SUPABASE_SERVICE_KEY)
    return new SupabaseStore(e.SUPABASE_URL, e.SUPABASE_SERVICE_KEY, e.DOCS_BUCKET ?? "documents");
  return new LocalStore(e.DOCS_DIR ?? join(process.cwd(), ".data", "docs"));
}

export function documentStore(e: Parameters<typeof storeFromEnv>[0]): BlobStore {
  cached ??= storeFromEnv(e);
  return cached;
}
