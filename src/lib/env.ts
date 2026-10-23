import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  ALLOWED_EMAILS: z.string().default(""),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  TOKEN_ENC_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().optional(),
  CRON_SECRET: z.string().min(16).optional(),
  DEV_LOGIN: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parsed lazily so `next build` never needs production secrets. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid environment — ${fields}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function googleConfigured(e: Env = env()): boolean {
  return Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
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
