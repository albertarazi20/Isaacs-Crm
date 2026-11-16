import { callCron } from "../lib/callCron.ts";

/** Every five minutes: read lender mail, count mail sent outside the CRM, tag merchant replies, chase quiet lenders. */
const run = async () => {
  await callCron("inbox");
};

export default run;

// Cron runs in UTC; Netlify runs scheduled functions only on the published production deploy.
export const config = { schedule: "*/5 * * * *" };
