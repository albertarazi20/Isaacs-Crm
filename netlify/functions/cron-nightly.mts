import { callCron } from "../lib/callCron.ts";

/** Hourly: bucket and win-back steps, deal and money clocks, renewals, rescue nudges, document retention. */
const run = async () => {
  await callCron("nightly");
};

export default run;

// Cron runs in UTC; Netlify runs scheduled functions only on the published production deploy.
export const config = { schedule: "0 * * * *" };
