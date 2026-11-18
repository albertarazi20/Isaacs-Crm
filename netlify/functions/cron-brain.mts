import { callCron } from "../lib/callCron.ts";

/** Every five minutes: the assistant prepares the next step for what is new on each rep's list. */
const run = async () => {
  await callCron("brain");
};

export default run;

// Cron runs in UTC; Netlify runs scheduled functions only on the published production deploy.
export const config = { schedule: "*/5 * * * *" };
