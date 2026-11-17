/**
 * The account types the database knows. Reps are all identical; managers have everything a rep has, plus the team.
 * Ops has no work left: the role stays in the database (an old account may hold it) but is not offered.
 */
export const ROLES = ["rep", "ops", "manager"] as const;
export type Role = (typeof ROLES)[number];

/** What the Team settings offer when adding someone or changing a role. */
export const OFFERED_ROLES = ["rep", "manager"] as const;

export const ROLE_LABEL: Record<Role, string> = { rep: "Rep", ops: "Ops", manager: "Manager" };

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

/** What each role can do. One place, so a page and its server action never disagree. */
export const CAN = {
  manageTeam: (r: Role) => r === "manager",
  seeEveryone: (r: Role) => r === "manager",
  editOffers: (r: Role) => r === "manager",
  confirmFunding: (r: Role) => r === "manager",
  exportData: (r: Role) => r === "manager",
  workLeads: (r: Role) => r === "rep" || r === "manager",
  runOps: (r: Role) => r === "ops" || r === "manager",
} as const;
