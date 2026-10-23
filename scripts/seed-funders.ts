/**
 * Demo funders for a LOCAL dev database, on top of `pnpm db:seed`: five (fictional) funders with different
 * appetites, then a few of the seeded merchants sent out — some answered with offers, some declined,
 * some still waiting — so the Funders scoreboard and the Submissions card have something to show.
 *
 *   DATABASE_URL=postgres://postgres@localhost:5433/isaac_dev pnpm tsx scripts/seed-funders.ts isaac@example.com
 *
 * Goes through the same mutation layer the app uses. Refuses to run against anything that is not
 * localhost, and does nothing if the user already has funders.
 */
import pg from "../src/lib/db/pg";
import { makeDb } from "../src/lib/db";
import * as m from "../src/lib/funders/mutations";
import * as s from "../src/lib/funders/schemas";

const url = process.env.DATABASE_URL ?? "";
const email = (process.argv[2] ?? "isaac@example.com").toLowerCase();
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error("seed-funders only runs against a localhost DATABASE_URL");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
const db = makeDb(pool);

const user = await pool.query<{ id: string }>("select id from app_users where email = $1", [email]);
const userId = user.rows[0]?.id;
if (!userId) {
  console.error(`no user ${email} — run pnpm db:seed ${email} first`);
  process.exit(1);
}
const have = await pool.query("select count(*)::int as n from funders where user_id = $1", [
  userId,
]);
if (have.rows[0].n > 0) {
  console.log(`${email} already has ${have.rows[0].n} funders — nothing to do`);
  await pool.end();
  process.exit(0);
}

const FUNDERS = [
  {
    name: "Harbor Capital",
    contactName: "Dana Whitfield",
    submissionEmail: "submissions@harborcapital.example",
    minMonthlyRevenue: "40k",
    minTimeInBusinessMonths: "12",
    maxPosition: "2",
    excludedIndustries: "trucking, cannabis",
    commissionPoints: "9",
    renewalPaydownPct: "50",
  },
  {
    name: "Summit Advance",
    contactName: "Raj Patel",
    submissionEmail: "deals@summitadvance.example",
    minMonthlyRevenue: "25k",
    maxPosition: "1",
    excludedStates: "CA, NY",
    commissionPoints: "10",
    renewalPaydownPct: "60",
  },
  {
    name: "Bluewater Funding",
    contactName: "Maria Lopez",
    submissionEmail: "subs@bluewaterfunding.example",
    minMonthlyRevenue: "15k",
    minTimeInBusinessMonths: "6",
    maxPosition: "4",
    minAmount: "10k",
    maxAmount: "150k",
    excludedIndustries: "restaurants",
    commissionPoints: "8",
  },
  {
    name: "Ironbridge Capital",
    minMonthlyRevenue: "75k",
    minTimeInBusinessMonths: "24",
    maxPosition: "2",
    minAmount: "50k",
    commissionPoints: "11",
    notes: "Slow on weekends. Wants 4 months of statements.",
  },
  {
    name: "Kestrel Funding",
    contactName: "Sam Okafor",
    submissionEmail: "intake@kestrelfunding.example",
    maxPosition: "3",
    excludedStates: "FL",
    excludedIndustries: "auto repair, trucking",
    commissionPoints: "7.5",
  },
];

interface Plan {
  merchant: string;
  sentTo: string[];
  outcomes: Record<
    string,
    | {
        offer: {
          amount: string;
          factorRate: string;
          payment: string;
          frequency: "daily" | "weekly";
          termDays: string;
        };
      }
    | { decline: s.StatusInput["declineReason"]; note?: string }
    | { stips: string }
    | { silent: true }
  >;
}

const PLANS: Plan[] = [
  {
    merchant: "Pioneer Auto Glass",
    sentTo: ["Harbor Capital", "Bluewater Funding", "Kestrel Funding"],
    outcomes: {
      "Harbor Capital": {
        offer: {
          amount: "45k",
          factorRate: "1.34",
          payment: "450",
          frequency: "daily",
          termDays: "130",
        },
      },
      "Bluewater Funding": {
        offer: {
          amount: "40k",
          factorRate: "1.31",
          payment: "400",
          frequency: "daily",
          termDays: "125",
        },
      },
      "Kestrel Funding": { decline: "industry", note: "no auto" },
    },
  },
  {
    merchant: "Titan Logistics",
    sentTo: ["Harbor Capital", "Summit Advance", "Bluewater Funding"],
    outcomes: {
      "Harbor Capital": { decline: "industry", note: "trucking" },
      "Summit Advance": { decline: "position" },
      "Bluewater Funding": { stips: "3 months of statements and a voided check" },
    },
  },
  {
    merchant: "Riverside Cafe",
    sentTo: ["Harbor Capital", "Summit Advance"],
    outcomes: {
      "Harbor Capital": { decline: "revenue", note: "wants 40k+ a month" },
      "Summit Advance": { silent: true },
    },
  },
  {
    merchant: "Golden Wok",
    sentTo: ["Summit Advance", "Ironbridge Capital", "Kestrel Funding"],
    outcomes: {
      "Summit Advance": {
        offer: {
          amount: "30k",
          factorRate: "1.38",
          payment: "1,000",
          frequency: "weekly",
          termDays: "150",
        },
      },
      "Ironbridge Capital": { decline: "time_in_business" },
      "Kestrel Funding": { silent: true },
    },
  },
];

await db.withUser(userId, async (q) => {
  const ids = new Map<string, string>();
  for (const f of FUNDERS) {
    ids.set(f.name, await m.saveFunder(q, s.funderSchema.parse(f)));
  }
  for (const plan of PLANS) {
    const { rows } = await q.query<{ id: string }>(
      "select id from clients where business_name = $1",
      [plan.merchant],
    );
    const clientId = rows[0]?.id;
    if (!clientId) {
      console.log(`  skipped ${plan.merchant} (not in this user's data)`);
      continue;
    }
    await m.sendToFunders(
      q,
      s.sendSchema.parse({
        clientId,
        funderIds: plan.sentTo.map((n) => ids.get(n)),
        note: "Application and 3 months of statements",
      }),
    );
    const subs = await q.query<{ id: string; name: string }>(
      "select s.id, f.name from submissions s join funders f on f.id = s.funder_id where s.client_id = $1",
      [clientId],
    );
    for (const sub of subs.rows) {
      const o = plan.outcomes[sub.name];
      if (!o || "silent" in o) continue;
      if ("offer" in o)
        await m.recordOffer(q, s.offerSchema.parse({ submissionId: sub.id, ...o.offer }));
      else if ("decline" in o)
        await m.setSubmissionStatus(
          q,
          s.statusSchema.parse({
            submissionId: sub.id,
            status: "declined",
            declineReason: o.decline,
            note: o.note ?? "",
          }),
        );
      else
        await m.setSubmissionStatus(
          q,
          s.statusSchema.parse({ submissionId: sub.id, status: "stips_requested", note: o.stips }),
        );
    }
    console.log(`  ${plan.merchant}: sent to ${plan.sentTo.join(", ")}`);
  }
});
console.log(`seeded ${FUNDERS.length} funders for ${email}`);
await pool.end();
