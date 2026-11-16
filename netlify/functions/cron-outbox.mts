import { callCron } from "../lib/callCron.ts";

/** Every five minutes: send whatever mail is due, scan new uploads. */
const run = async () => {
  await callCron("outbox");
};

export default run;

// Cron runs in UTC; Netlify runs scheduled functions only on the published production deploy.
export const config = { schedule: "*/5 * * * *" };
