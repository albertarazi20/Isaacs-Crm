/**
 * Demo data for a LOCAL dev database: ~45 merchants spread across every stage, with positions,
 * asks, competing offers, stips, fundings, defaults and call notes — some overdue, some due today.
 *
 *   DATABASE_URL=postgres://postgres@localhost:5433/isaac_dev pnpm tsx scripts/seed-dev.ts isaac@example.com
 *
 * Refuses to run against anything that is not localhost.
 */
import pg from "../src/lib/db/pg";
import { makeDb, type Db } from "../src/lib/db";
import * as m from "../src/lib/data/mutations";
import { getClientDetail, userContext } from "../src/lib/data/queries";
import { moveSchema, newClientSchema } from "../src/lib/data/schemas";
import { addDays } from "../src/lib/mca/dates";
import { parseMoney } from "../src/lib/money";
import type { StageKey } from "../src/lib/mca/stages";

const url = process.env.DATABASE_URL ?? "";
const email = (process.argv[2] ?? "isaac@example.com").toLowerCase();
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error("seed-dev only runs against a localhost DATABASE_URL");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
const db = makeDb(pool);

const { rows } = await pool.query<{ id: string }>(
  "insert into app_users (email, name, timezone) values ($1, $2, 'America/New_York') on conflict (email) do update set email = excluded.email returning id",
  [email, "Isaac"],
);
const userId = rows[0]?.id as string;
const existing = await pool.query("select count(*)::int as n from clients where user_id = $1", [
  userId,
]);
if (existing.rows[0].n > 0) {
  console.log(`${email} already has ${existing.rows[0].n} clients — nothing to do`);
  await pool.end();
  process.exit(0);
}

interface Seed {
  biz: string;
  who: string;
  phone: string;
  stage: StageKey;
  /** days from today for the next follow-up; negative = overdue */
  due: number;
  want?: string;
  approve?: string;
  terms?: string;
  industry?: string;
  note?: string;
  positions?: [number, string, string, string, string][]; // no, funder, funded, payback, balance
  stips?: number; // how many required stips are ticked
  fundedDaysAgo?: number;
  email?: string;
}

const S: Seed[] = [
  {
    biz: "Mike's Pizza",
    who: "Mike Ross",
    phone: "(305) 555-0101",
    stage: "name_in",
    due: 0,
    industry: "Restaurant",
  },
  {
    biz: "Bella Nails & Spa",
    who: "Linh Tran",
    phone: "(305) 555-0102",
    stage: "name_in",
    due: 1,
    industry: "Salon",
  },
  {
    biz: "Cruz Landscaping",
    who: "Luis Cruz",
    phone: "(786) 555-0103",
    stage: "name_in",
    due: -1,
    industry: "Landscaping",
  },
  {
    biz: "Hartman Trucking",
    who: "Dave Hartman",
    phone: "(212) 555-0111",
    stage: "spoke_with_owner",
    due: 0,
    want: "80k",
    industry: "Trucking",
    note: "Spoke 10 min. Two trucks down, needs cash for repairs. Call back after he talks to his dispatcher.",
  },
  {
    biz: "Green Leaf Market",
    who: "Priya Nair",
    phone: "(212) 555-0112",
    stage: "spoke_with_owner",
    due: 2,
    want: "40k",
    industry: "Grocery",
  },
  {
    biz: "Sunrise Dental",
    who: "Dr. Alan Weiss",
    phone: "(646) 555-0113",
    stage: "spoke_with_owner",
    due: -2,
    want: "120k",
    industry: "Medical",
    note: "Wants to buy new chair + scanner. Slow to return calls.",
  },
  {
    biz: "Rivera Auto Repair",
    who: "Tony Rivera",
    phone: "(305) 555-0121",
    stage: "interested",
    due: 0,
    want: "60k",
    approve: "35k",
    terms: "6 months, daily",
    industry: "Auto repair",
    note: "Has two other advances. Slammed with payments. Wants fresh money to cover payroll.",
    positions: [
      [1, "Libertas", "40k", "54.8k", "21k"],
      [2, "Cobalt Capital", "25k", "35.5k", "30k"],
    ],
  },
  {
    biz: "Oak & Iron Fitness",
    who: "Jess Monroe",
    phone: "(305) 555-0122",
    stage: "interested",
    due: 1,
    want: "50k",
    approve: "50k",
    terms: "9 months, weekly",
    industry: "Fitness",
    positions: [],
  },
  {
    biz: "Patel Convenience",
    who: "Raj Patel",
    phone: "(973) 555-0123",
    stage: "interested",
    due: -3,
    want: "35k",
    approve: "20k",
    industry: "Retail",
    note: "First position. Statements look thin in August.",
    positions: [],
  },
  {
    biz: "Coastal HVAC",
    who: "Bill Dunn",
    phone: "(954) 555-0124",
    stage: "interested",
    due: 3,
    want: "150k",
    approve: "90k",
    terms: "12 months",
    industry: "HVAC",
    positions: [[1, "Pearl Funding", "70k", "98k", "61k"]],
  },
  {
    biz: "Lakeview Bakery",
    who: "Maria Soto",
    phone: "(305) 555-0131",
    stage: "call_scheduled",
    due: 0,
    want: "45k",
    industry: "Restaurant",
  },
  {
    biz: "Northside Plumbing",
    who: "Gary Bell",
    phone: "(404) 555-0132",
    stage: "call_scheduled",
    due: 2,
    want: "70k",
    industry: "Plumbing",
  },
  {
    biz: "Delta Staffing",
    who: "Tasha Greene",
    phone: "(404) 555-0141",
    stage: "application_sent",
    due: -1,
    want: "100k",
    industry: "Staffing",
    note: "Sent app Tuesday. Said she'd sign tonight.",
  },
  {
    biz: "Mendez Roofing",
    who: "Carlos Mendez",
    phone: "(305) 555-0142",
    stage: "application_sent",
    due: 1,
    want: "55k",
    industry: "Construction",
  },
  {
    biz: "Harbor Seafood",
    who: "Frank Doyle",
    phone: "(617) 555-0151",
    stage: "application_in",
    due: 0,
    want: "90k",
    industry: "Restaurant",
  },
  {
    biz: "Bright Smiles Pediatrics",
    who: "Dr. Kim Ellis",
    phone: "(617) 555-0152",
    stage: "application_in",
    due: 1,
    want: "200k",
    industry: "Medical",
  },
  {
    biz: "Pioneer Auto Glass",
    who: "Hector Vale",
    phone: "(305) 555-0161",
    stage: "stips",
    due: -2,
    want: "65k",
    industry: "Auto repair",
    stips: 4,
    note: "Missing Sep statement + voided check.",
  },
  {
    biz: "Riverside Cafe",
    who: "Annie Park",
    phone: "(212) 555-0162",
    stage: "stips",
    due: 0,
    want: "30k",
    industry: "Restaurant",
    stips: 7,
  },
  {
    biz: "Titan Logistics",
    who: "Omar Haddad",
    phone: "(973) 555-0163",
    stage: "stips",
    due: 2,
    want: "250k",
    industry: "Trucking",
    stips: 2,
  },
  {
    biz: "Verde Landscaping",
    who: "Sam Ortega",
    phone: "(786) 555-0171",
    stage: "submitted",
    due: 0,
    want: "75k",
    industry: "Landscaping",
    stips: 7,
    note: "Out to Libertas, Pearl, Cobalt, Nova.",
  },
  {
    biz: "Crescent Pharmacy",
    who: "Neil Shah",
    phone: "(646) 555-0172",
    stage: "submitted",
    due: 1,
    want: "110k",
    industry: "Pharmacy",
    stips: 7,
  },
  {
    biz: "Atlas Moving",
    who: "Jerome Pike",
    phone: "(404) 555-0181",
    stage: "offers_in",
    due: 0,
    want: "60k",
    approve: "48k",
    industry: "Moving",
    stips: 7,
    note: "Pearl at 1.34 for 45k daily. Libertas at 1.31 for 40k.",
  },
  {
    biz: "Golden Wok",
    who: "David Chen",
    phone: "(212) 555-0182",
    stage: "offers_in",
    due: -1,
    want: "80k",
    approve: "65k",
    industry: "Restaurant",
    stips: 7,
  },
  {
    biz: "Sparks Electric",
    who: "Will Sparks",
    phone: "(954) 555-0191",
    stage: "offer_presented",
    due: 1,
    want: "95k",
    approve: "80k",
    industry: "Construction",
    stips: 7,
    note: "Presented 80k @ 1.33. Wants to sleep on it.",
  },
  {
    biz: "Bayou Boats",
    who: "Remy Landry",
    phone: "(504) 555-0192",
    stage: "offer_presented",
    due: 0,
    want: "130k",
    approve: "100k",
    industry: "Retail",
    stips: 7,
  },
  {
    biz: "Marlin Marine Supply",
    who: "Ken Marlin",
    phone: "(954) 555-0193",
    stage: "contract_out",
    due: 0,
    want: "85k",
    approve: "85k",
    industry: "Retail",
    stips: 7,
    note: "DocuSign sent 10am.",
  },
  {
    biz: "Summit Roofing",
    who: "Pete Gallo",
    phone: "(305) 555-0201",
    stage: "funded",
    due: 12,
    industry: "Construction",
    fundedDaysAgo: 18,
  },
  {
    biz: "Blue Door Bistro",
    who: "Elise Moreau",
    phone: "(212) 555-0202",
    stage: "funded",
    due: 0,
    industry: "Restaurant",
    fundedDaysAgo: 30,
  },
  {
    biz: "Apex Dental Lab",
    who: "Dr. Raj Menon",
    phone: "(646) 555-0203",
    stage: "funded",
    due: 34,
    industry: "Medical",
    fundedDaysAgo: 96,
  },
  {
    biz: "Iron Ridge Gym",
    who: "Marcus Webb",
    phone: "(404) 555-0204",
    stage: "funded",
    due: -2,
    industry: "Fitness",
    fundedDaysAgo: 125,
  },
  {
    biz: "Sol Y Mar Grill",
    who: "Ana Reyes",
    phone: "(305) 555-0205",
    stage: "funded",
    due: 20,
    industry: "Restaurant",
    fundedDaysAgo: 60,
  },
  {
    biz: "Prime Cuts Barbers",
    who: "Andre Hill",
    phone: "(404) 555-0211",
    stage: "paying_off_soon",
    due: 0,
    industry: "Salon",
    fundedDaysAgo: 150,
    note: "At 85%. Wants to renew for more.",
  },
  {
    biz: "Eastside Towing",
    who: "Lou Bianchi",
    phone: "(973) 555-0212",
    stage: "paying_off_soon",
    due: 5,
    industry: "Auto repair",
    fundedDaysAgo: 140,
  },
  {
    biz: "Cedar Print Shop",
    who: "Holly Vance",
    phone: "(617) 555-0221",
    stage: "paid_in_full",
    due: 0,
    industry: "Retail",
    fundedDaysAgo: 220,
    note: "Paid off early. Great client. Hot renewal.",
  },
  {
    biz: "Duke's Detailing",
    who: "Duke Alvarez",
    phone: "(305) 555-0222",
    stage: "paid_in_full",
    due: 9,
    industry: "Auto repair",
    fundedDaysAgo: 200,
  },
  {
    biz: "Fresh Start Laundry",
    who: "Bao Nguyen",
    phone: "(714) 555-0231",
    stage: "default_workable",
    due: 0,
    industry: "Retail",
    fundedDaysAgo: 75,
    note: "Missed 4 payments — slow season. Promised $1,500 Friday.",
  },
  {
    biz: "Kingfisher Charters",
    who: "Matt Roy",
    phone: "(954) 555-0232",
    stage: "default_workable",
    due: -1,
    industry: "Tourism",
    fundedDaysAgo: 80,
  },
  {
    biz: "Rapid Courier",
    who: "Zed Carter",
    phone: "(404) 555-0241",
    stage: "default_bad",
    due: 0,
    industry: "Trucking",
    fundedDaysAgo: 110,
    note: "Not answering. ACH stopped 3 weeks ago.",
  },
  {
    biz: "Lucky Star Diner",
    who: "Gus Pappas",
    phone: "(212) 555-0242",
    stage: "default_bad",
    due: 4,
    industry: "Restaurant",
    fundedDaysAgo: 100,
  },
  {
    biz: "Omega Builders",
    who: "Rick Stone",
    phone: "(305) 555-0251",
    stage: "legal_collections",
    due: 6,
    industry: "Construction",
    fundedDaysAgo: 160,
  },
  {
    biz: "Wavy Surf Shop",
    who: "Kai Lopes",
    phone: "(954) 555-0261",
    stage: "written_off",
    due: 300,
    industry: "Retail",
    fundedDaysAgo: 400,
  },
  {
    biz: "Orchid Day Spa",
    who: "Mei Lin",
    phone: "(305) 555-0271",
    stage: "declined",
    due: 80,
    want: "60k",
    industry: "Salon",
    note: "Declined — NSFs in Aug. Revenue improving.",
  },
  {
    biz: "Triple J Farms",
    who: "Jim Jacobs",
    phone: "(813) 555-0272",
    stage: "declined",
    due: 20,
    want: "90k",
    industry: "Agriculture",
  },
  {
    biz: "Nova Tech Repair",
    who: "Eli Park",
    phone: "(212) 555-0281",
    stage: "lost",
    due: 95,
    want: "50k",
    industry: "Retail",
    note: "Went with Rival Capital. 1.42, 6 months.",
  },
  {
    biz: "Park Place Parking",
    who: "Ron Ellis",
    phone: "(617) 555-0282",
    stage: "lost",
    due: -5,
    want: "70k",
    industry: "Parking",
  },
  {
    biz: "Sweet Tooth Candy",
    who: "Gina Rossi",
    phone: "(305) 555-0283",
    stage: "lost",
    due: 40,
    want: "30k",
    industry: "Retail",
  },
  {
    biz: "Quick Fix Phones",
    who: "Sal Kamal",
    phone: "(973) 555-0291",
    stage: "killed",
    due: 150,
    want: "25k",
    industry: "Retail",
    note: "Owner pulled the app — found a family loan.",
  },
  {
    biz: "Dream Weddings",
    who: "Cara Bell",
    phone: "(404) 555-0292",
    stage: "dead",
    due: 240,
    want: "55k",
    industry: "Events",
  },
  {
    biz: "Old Town Pubs",
    who: "Paddy Walsh",
    phone: "(617) 555-0293",
    stage: "dead",
    due: 15,
    want: "100k",
    industry: "Restaurant",
  },
  {
    biz: "Zen Yoga Studio",
    who: "Amy Fox",
    phone: "(212) 555-0294",
    stage: "not_interested",
    due: 330,
    want: "20k",
    industry: "Fitness",
  },
  {
    biz: "Wolf Security",
    who: "Vic Wolf",
    phone: "(954) 555-0295",
    stage: "not_interested",
    due: 500,
    want: "45k",
    industry: "Security",
  },
];

const FUNDING = {
  amount: "50k",
  factorRate: "1.32",
  payment: "550",
  frequency: "daily" as const,
  funderName: "Alpha Capital",
};

await db.withUser(userId, async (q: Db) => {
  const ctx = await userContext(q);
  for (const s of S) {
    const start: StageKey =
      s.stage === "funded" ||
      [
        "paying_off_soon",
        "paid_in_full",
        "default_workable",
        "default_bad",
        "legal_collections",
        "written_off",
      ].includes(s.stage)
        ? "name_in"
        : s.stage;
    const card = await m.createClient(
      q,
      newClientSchema.parse({
        businessName: s.biz,
        contactName: s.who,
        phone: s.phone,
        industry: s.industry ?? "",
        email: s.email ?? `${s.who.split(" ").pop()?.toLowerCase().replace(/\W/g, "")}@example.com`,
        stage: start,
        wantedAmount: s.want,
      }),
      ctx,
    );
    if (s.want || s.approve || s.terms) {
      await m.saveAsk(q, {
        clientId: card.id,
        wantedAmount: s.want ? parseMoney(s.want) : null,
        wantedTerms: s.terms ?? "",
        estApproval: s.approve ? parseMoney(s.approve) : null,
        estApprovalNote: s.approve ? "Based on the last 4 months of deposits" : "",
      });
    }
    for (const [no, funder, funded, payback, balance] of s.positions ?? []) {
      await m.savePosition(q, {
        clientId: card.id,
        positionNo: no,
        funderName: funder,
        fundedAmount: parseMoney(funded),
        payback: parseMoney(payback),
        balance: parseMoney(balance),
        payment: null,
        frequency: "daily",
        fundedOn: null,
        note: "",
      });
    }
    if (s.fundedDaysAgo !== undefined) {
      await m.moveClient(
        q,
        moveSchema.parse({
          clientId: card.id,
          stage: "funded",
          funding: {
            ...FUNDING,
            fundedOn: addDays(ctx.today, -s.fundedDaysAgo),
            factorRate: String(1.28 + (s.biz.length % 6) / 100),
          },
        }),
        ctx,
      );
      if (s.stage !== "funded")
        await m.moveClient(
          q,
          moveSchema.parse({
            clientId: card.id,
            stage: s.stage,
            default:
              s.stage.startsWith("default") || s.stage === "legal_collections"
                ? {
                    defaultedOn: addDays(ctx.today, -12),
                    promiseToPayAt:
                      s.biz === "Fresh Start Laundry"
                        ? `${addDays(ctx.today, 3)}T14:30`
                        : undefined,
                    promiseAmount: s.biz === "Fresh Start Laundry" ? "1500" : undefined,
                  }
                : undefined,
          }),
          ctx,
        );
    } else if (s.stage === "lost") {
      await m.moveClient(
        q,
        moveSchema.parse({
          clientId: card.id,
          stage: "lost",
          competitor: {
            funderName: "Rival Capital",
            amount: s.want,
            factorRate: "1.42",
            termDays: 180,
            positionNo: 1,
          },
        }),
        ctx,
      );
    }
    if (s.stips !== undefined) {
      await m.seedStips(q, card.id, ctx);
      const d = await getClientDetail(q, card.id);
      for (const st of (d?.stips ?? []).filter((x) => x.required).slice(0, s.stips))
        await m.setStip(q, { stipId: st.id, received: true });
    }
    if (s.note)
      await m.logTouch(
        q,
        { clientId: card.id, kind: "call", outcome: "reached", body: s.note },
        ctx,
      );
  }
});

// Back-date timers to the shape of a real working day: some overdue, some due today.
const cards = await pool.query<{ id: string; business_name: string }>(
  "select id, business_name from clients where user_id = $1",
  [userId],
);
const today =
  (
    await pool.query<{ d: string }>(
      "select (now() at time zone 'America/New_York')::date::text as d",
    )
  ).rows[0]?.d ?? "";
for (const c of cards.rows) {
  const s = S.find((x) => x.biz === c.business_name);
  if (!s) continue;
  await pool.query(
    `update timers set due_on = ($2::date + $3::int) where client_id = $1 and done_at is null and kind in ('follow_up', 'check_in')`,
    [c.id, today, s.due],
  );
}
console.log(`seeded ${S.length} clients for ${email}`);
await pool.end();
