/**
 * Calls one of the app's scheduled-job routes from a Netlify scheduled function (this replaces an outside
 * scheduler). The routes themselves check the bearer secret, so a stranger who finds the URL gets a 401.
 * Reads APP_URL and CRON_SECRET from the site's environment variables (scope: Functions).
 */
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
    // 200 = ran clean, 207 = ran with a partial failure the route already logged, 502/503 = see the route's own JSON
    console.log(`cron ${job}: ${res.status}`);
  } catch (e) {
    console.error(`cron ${job}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
