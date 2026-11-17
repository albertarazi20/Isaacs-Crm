/**
 * Demo data for a LOCAL dev database: merchants being brought in, across the stages the app works, with asks,
 * stips and call notes — some overdue, some due today.
 *
 *   DATABASE_URL=postgres://postgres@localhost:5433/isaac_dev pnpm tsx scripts/seed-dev.ts isaac@example.com
 *
 * Refuses to run against anything that is not localhost.
 */
import pg from "../src/lib/db/pg";
import { makeDb, type Db } from "../src/lib/db";
import * as m from "../src/lib/data/mutations";
import { getClientDetail, userContext } from "../src/lib/data/queries";
import { newClientSchema } from "../src/lib/data/schemas";
import { foldStage, type StageKey } from "../src/lib/mca/stages";

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
  industry?: string;
  note?: string;
  stips?: number; // how many required stips are ticked
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
    industry: "Auto repair",
    note: "Slammed with daily payments. Wants fresh money to cover payroll.",
  },
  {
    biz: "Oak & Iron Fitness",
    who: "Jess Monroe",
    phone: "(305) 555-0122",
    stage: "interested",
    due: 1,
    want: "50k",
    industry: "Fitness",
  },
  {
    biz: "Patel Convenience",
    who: "Raj Patel",
    phone: "(973) 555-0123",
    stage: "interested",
    due: -3,
    want: "35k",
    industry: "Retail",
    note: "First position. Statements look thin in August.",
  },
  {
    biz: "Coastal HVAC",
    who: "Bill Dunn",
    phone: "(954) 555-0124",
    stage: "interested",
    due: 3,
    want: "150k",
    industry: "HVAC",
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

await db.withUser(userId, async (q: Db) => {
  const ctx = await userContext(q);
  // Only the short stage list: retired stages fold into the ones the pickers offer.
  for (const s of S.map((x) => ({ ...x, stage: foldStage(x.stage) }))) {
    const card = await m.createClient(
      q,
      newClientSchema.parse({
        businessName: s.biz,
        contactName: s.who,
        phone: s.phone,
        industry: s.industry ?? "",
        email: s.email ?? `${s.who.split(" ").pop()?.toLowerCase().replace(/\W/g, "")}@example.com`,
        stage: s.stage,
        wantedAmount: s.want,
      }),
      ctx,
    );
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
    `update timers set due_on = ($2::date + $3::int) where client_id = $1 and done_at is null and kind = 'follow_up'`,
    [c.id, today, s.due],
  );
}
console.log(`seeded ${S.length} clients for ${email}`);
await pool.end();
