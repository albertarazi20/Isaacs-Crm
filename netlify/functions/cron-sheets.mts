import { callCron } from "../lib/callCron.ts";

/** Every ten minutes: pull the connected lead sheets and file new rows. */
const run = async () => {
  await callCron("sheets");
};

export default run;

// Cron runs in UTC; Netlify runs scheduled functions only on the published production deploy.
export const config = { schedule: "*/10 * * * *" };
