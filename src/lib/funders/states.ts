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
