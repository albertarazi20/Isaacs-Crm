import { z } from "zod";

/** A variable pasted in blank (the `.env.example` habit) means "not set", not "invalid". */
const blankIsUnset = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = (s: z.ZodType<string>) => z.preprocess(blankIsUnset, s.optional());

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  // No trailing slash: links and the Google redirect URI are built as `${APP_URL}/path`, and `//` is a mismatch.
  APP_URL: z.preprocess(
    (v) => blankIsUnset(typeof v === "string" ? v.trim().replace(/\/+$/, "") : v),
    z.string().url().default("http://localhost:3000"),
  ),
  ALLOWED_EMAILS: z.string().default(""),
  GOOGLE_CLIENT_ID: optional(z.string()),
  GOOGLE_CLIENT_SECRET: optional(z.string()),
  TOKEN_ENC_KEY: optional(z.string()),
  RESEND_API_KEY: optional(z.string()),
  RESEND_FROM: optional(z.string()),
  CRON_SECRET: optional(z.string().min(16)),
  // Sign-in without Google: one shared passcode, signs in as the first ALLOWED_EMAILS address.
  ACCESS_PASSCODE: optional(z.string().min(12, "ACCESS_PASSCODE must be at least 12 characters")),
  DEV_LOGIN: optional(z.string()),
  ANTHROPIC_API_KEY: optional(z.string()),
  RESEND_WEBHOOK_SECRET: optional(z.string()),
  TELNYX_API_KEY: optional(z.string()),
  // Document bytes: Supabase Storage (private bucket, service key) in production; a local folder in development.
  SUPABASE_URL: optional(z.string().url()),
  SUPABASE_SERVICE_KEY: optional(z.string()),
  DOCS_BUCKET: optional(z.string()),
  DOCS_DIR: optional(z.string()),
});

export type Env = z.infer<typeof schema>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * In a production build, links and the Google redirect URI come from APP_URL, so a missing or `http://` value would
 * quietly send everyone to localhost or a mismatched address. Fail loudly instead. A production build run on this
 * machine (localhost) may still use http.
 */
export function productionUrlProblem(appUrl: string, rawAppUrl: string | undefined): string | null {
  if (!rawAppUrl || rawAppUrl.trim() === "")
    return "APP_URL: is not set. Set it to the public address, for example https://isaac.example.com";
  const url = new URL(appUrl);
  if (LOCAL_HOSTS.has(url.hostname)) return null;
  if (url.protocol !== "https:") return "APP_URL: must start with https:// in production";
  return null;
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment — ${fields}`);
  }
  if (source.NODE_ENV === "production") {
    const problem = productionUrlProblem(parsed.data.APP_URL, source.APP_URL);
    if (problem) throw new Error(`Invalid environment — ${problem}`);
  }
  return parsed.data;
}

let cached: Env | undefined;

/** Parsed lazily so `next build` never needs production secrets. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

export function googleConfigured(e: Env = env()): boolean {
  return Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
}

export function passcodeConfigured(e: Env = env()): boolean {
  return Boolean(e.ACCESS_PASSCODE && firstAllowedEmail(e.ALLOWED_EMAILS));
}

/** The address a passcode sign-in acts as: the first entry of ALLOWED_EMAILS. */
export function firstAllowedEmail(list: string): string | undefined {
  return list
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .find(Boolean);
}

/** The dev login skips Google. It can never switch on in production. */
export function devLoginEnabled(e: Env = env()): boolean {
  if (process.env.NODE_ENV === "production" || e.DEV_LOGIN !== "1") return false;
  // Skips Google AND the allowlist, so it must be impossible to leave on for a public URL.
  try {
    const host = new URL(e.APP_URL).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}
