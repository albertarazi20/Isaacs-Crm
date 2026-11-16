import { callCron } from "../lib/callCron.ts";

/** Hourly at :05: morning brief, call reminders, weekly scorecards, the alert email, month-end close. */
const run = async () => {
  await callCron("reminders");
};

export default run;

// Cron runs in UTC; Netlify runs scheduled functions only on the published production deploy.
export const config = { schedule: "5 * * * *" };
