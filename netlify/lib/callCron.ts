/**
 * Calls one of the app's scheduled-job routes from a Netlify scheduled function (this replaces an outside
 * scheduler). The routes themselves check the bearer secret, so a stranger who finds the URL gets a 401.
 * Reads APP_URL and CRON_SECRET from the site's environment variables (scope: Functions).
 */
async function isNotConfigured(res: Response): Promise<boolean> {
  try {
    const body: unknown = await res.json();
    const error = (body as { error?: unknown } | null)?.error;
    return typeof error === "string" && /not configured/i.test(error);
  } catch {
    return false;
  }
}

export async function callCron(
  job: "outbox" | "inbox" | "sheets" | "nightly" | "reminders" | "brain",
): Promise<void> {
  const base = process.env.APP_URL?.replace(/\/+$/, "");
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) {
    console.error(
      `cron ${job}: APP_URL or CRON_SECRET is not set on this site, so nothing was called`,
    );
    return;
  }
  try {
    const res = await fetch(`${base}/api/cron/${job}`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(25_000),
    });
    // 200 = ran clean, 207 = ran with a partial failure the route already logged. A 503 whose JSON says the job is
    // "not configured" is the route's documented skip (reminders before RESEND_API_KEY / RESEND_FROM exist; the app's
    // own banner covers it): logged, not a failed run. Anything else (a 401 from a rotated secret, a 500, a 502, any
    // other 503) is a failed run: it is logged as an error and the function fails, so Netlify's run list shows it.
    if (res.status === 207)
      console.warn(`cron ${job}: 207 (partial failure, see the route's JSON)`);
    else if (res.status === 503 && (await isNotConfigured(res)))
      console.warn(`cron ${job}: 503 (not configured on the app, skipped)`);
    else if (!res.ok) throw new Error(`cron ${job}: ${res.status}`);
    else console.log(`cron ${job}: ${res.status}`);
  } catch (e) {
    console.error(`cron ${job}: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}
