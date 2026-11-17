/** US states. Merchants' states are free text ("FL", "florida"), so they go through here to become a code. */
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
