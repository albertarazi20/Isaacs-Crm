/** US states, for funder state exclusions. Merchants' states are free text ("FL", "florida"), so both sides go through here. */
export const STATES: Readonly<Record<string, string>> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  PR: "Puerto Rico",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

const BY_NAME: ReadonlyMap<string, string> = new Map([
  ...Object.entries(STATES).map(([code, name]) => [name.toLowerCase(), code] as const),
  ["washington dc", "DC"],
  ["washington d c", "DC"],
]);

/** "fl", "FL.", "Florida", "new york" → the two-letter code. Anything else → null (unknown, not wrong). */
export function normalizeState(raw: string): string | null {
  const s = raw.trim().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  if (s === "") return null;
  const code = s.replace(/ /g, "").toUpperCase();
  if (code.length === 2 && code in STATES) return code;
  return BY_NAME.get(s.toLowerCase()) ?? null;
}

/** Split a typed list ("FL, NY\nTX"), drop blanks, drop repeats (case-insensitive), keep the first spelling. */
export function splitList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;\n]+/)) {
    const v = part.trim();
    const key = v.toLowerCase();
    if (v === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** A typed list of states → codes. `unknown` holds what could not be read, so the form can say so. */
export function parseStateList(raw: string): { states: string[]; unknown: string[] } {
  const states: string[] = [];
  const unknown: string[] = [];
  for (const part of splitList(raw)) {
    const code = normalizeState(part);
    if (code === null) unknown.push(part);
    else if (!states.includes(code)) states.push(code);
  }
  return { states, unknown };
}

// ---------- compliance badge (plan §13.1; audit S3-7) ----------

/** One row of state_rules, as the deal snapshot reads it. */
export interface StateRules {
  state: string;
  broker_registration: boolean;
  registration_deadline: string | null;
  advance_fee_ban: boolean;
  apr_wording_rule: boolean;
  disclosure_law: boolean;
  note: string;
}

/** One row of shop_registrations. */
export interface ShopRegistration {
  state: string;
  status: "none" | "filed" | "registered" | "exempt";
  renews_on: string | null;
  registration_no: string;
}

export type ComplianceTone = "none" | "ok" | "watch" | "stop";

export interface StateBadge {
  state: string | null;
  name: string | null;
  tone: ComplianceTone;
  /** The badge text: "TX · registered", "FL · fee rule", "Unknown state". */
  label: string;
  /** Plain-words warnings for the deal snapshot, worst first. */
  warnings: string[];
}

const REGISTRATION_WARNING_DAYS = 30;

/**
 * The state badge and its warnings from the rules table and the shop's registration row. Pure: the page loads the
 * two rows (state_rules, shop_registrations) and asks. `stop` means the file should not go to lenders as things
 * stand; `watch` means something to say or do before funding; `ok` means rules exist and are met.
 */
export function stateCompliance(
  rawState: string,
  rules: StateRules | null,
  registration: ShopRegistration | null,
  today: string,
): StateBadge {
  const code = normalizeState(rawState);
  if (code === null)
    return {
      state: null,
      name: null,
      tone: "none",
      label: rawState.trim() === "" ? "No state on file" : `Unknown state: ${rawState.trim()}`,
      warnings: [
        rawState.trim() === ""
          ? "Add the merchant's state: lenders and the rules depend on it"
          : `"${rawState.trim()}" is not a state we know — fix it before submitting`,
      ],
    };
  const name = STATES[code] ?? code;
  if (!rules)
    return { state: code, name, tone: "ok", label: `${code} · no special rules`, warnings: [] };
  const warnings: string[] = [];
  // `as`, not an annotation: assignments inside bump() must not narrow the variable to its first value
  let tone = "ok" as ComplianceTone;
  const bump = (t: ComplianceTone) => {
    if (t === "stop" || (t === "watch" && tone === "ok")) tone = t;
  };
  const registered = registration?.status === "registered" || registration?.status === "exempt";
  if (rules.broker_registration) {
    if (!registered) {
      bump("stop");
      warnings.push(
        registration?.status === "filed"
          ? `${name} requires broker registration — ours is filed, not yet granted`
          : `${name} requires broker registration and the shop has none on file`,
      );
    } else if (registration?.renews_on) {
      if (registration.renews_on < today) {
        bump("stop");
        warnings.push(`The ${code} registration lapsed on ${registration.renews_on}`);
      } else if (daysBetween(today, registration.renews_on) <= REGISTRATION_WARNING_DAYS) {
        bump("watch");
        warnings.push(`The ${code} registration renews on ${registration.renews_on}`);
      }
    }
  } else if (rules.registration_deadline && rules.registration_deadline > today) {
    bump("watch");
    warnings.push(`${name} will require broker registration from ${rules.registration_deadline}`);
  }
  if (rules.advance_fee_ban) {
    bump("watch");
    warnings.push("No fee may be collected before closing: PSF at closing or from proceeds only");
  }
  if (rules.apr_wording_rule) {
    bump("watch");
    warnings.push("No rate or cost wording to this merchant without an APR beside it");
  }
  if (rules.disclosure_law) {
    bump("watch");
    warnings.push("The lender's disclosure must be signed by the merchant before funding");
  }
  const short =
    tone === "stop"
      ? "not registered"
      : rules.broker_registration
        ? "registered"
        : rules.advance_fee_ban
          ? "fee rule"
          : rules.disclosure_law
            ? "disclosure law"
            : "no special rules";
  return { state: code, name, tone, label: `${code} · ${short}`, warnings };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
