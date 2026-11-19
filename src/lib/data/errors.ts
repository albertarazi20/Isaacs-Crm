import { ZodError } from "zod";
import { UserError } from "./mutations";

/** Postgres error codes our own SQL functions raise on purpose; their messages are written for Isaac. */
const SAFE_CODES = new Set(["22023", "P0002"]);

/** What a failed database check means in words, by the constraint's name (table_column_check). */
export function checkMessage(constraint: string | undefined): string {
  const c = constraint ?? "";
  if (c === "clients_business_name_check") return "Business name is required";
  if (/_cents_check$/.test(c) && /^client_asks_wanted/.test(c)) return "Enter an amount above $0";
  if (/_cents_check$/.test(c)) return "Amounts can't be negative";
  return "One of those values isn't allowed. Check the amounts and dates";
}

/** What a form field is called on screen, where the field's key alone would read badly. Any other key is spelled out from its camelCase. */
const FIELD_LABEL: Record<string, string> = {
  dailyCap: "Daily cap",
  amberAt: "Amber warning",
  reservedForIntake: "Kept for intake",
  sendWindowStart: "Send window start",
  sendWindowEnd: "Send window end",
  perMerchantDaily: "Emails per merchant a day",
  perMerchantWeekly: "Emails per merchant a week",
  automationFrom: "Automation sender",
  shopName: "Shop name",
  postalAddress: "Postal address",
  aiDailyCapCents: "AI daily cap",
  brainDailyPerRep: "Brain preparations per rep",
  aiModel: "AI model",
};

/** "perMerchantDaily" -> "Per merchant daily"; "send_window" -> "Send window". */
export function fieldLabel(key: string): string {
  const known = FIELD_LABEL[key];
  if (known) return known;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "That field";
}

/**
 * One zod issue in words. zod's own messages ("Too small: expected number to be >=50") name no field, so they are
 * rewritten with the field's label; a message somebody wrote for the field on purpose is already a sentence and is kept.
 */
export function issueMessage(issue: ZodError["issues"][number]): string {
  const key = [...issue.path].reverse().find((p): p is string => typeof p === "string");
  const label = key ? fieldLabel(key) : null;
  const stock = /^(Too (small|big)|Invalid input): /.test(issue.message);
  if (!label || !stock) return issue.message;
  if (issue.code === "too_small" || issue.code === "too_big") {
    const small = issue.code === "too_small";
    const limit = small ? issue.minimum : issue.maximum;
    const edge = issue.inclusive
      ? small
        ? "at least"
        : "at most"
      : small
        ? "more than"
        : "less than";
    if (issue.origin === "number") return `${label} must be ${edge} ${String(limit)}`;
    if (issue.origin === "string")
      return `${label} must be ${edge} ${String(limit)} character${Number(limit) === 1 ? "" : "s"}`;
    return `${label}: ${issue.message}`;
  }
  if (issue.code === "invalid_type" && issue.expected === "number")
    return `${label} must be a number`;
  return `${label}: ${issue.message}`;
}

export function toActionError(e: unknown): string {
  if (e instanceof UserError) return e.message;
  if (e instanceof ZodError) {
    if (e.issues.length === 0) return "That doesn't look right";
    // every failing field, once each, so fixing one and resubmitting doesn't reveal the next
    const said = [...new Set(e.issues.slice(0, 3).map(issueMessage))];
    const more = e.issues.length - 3;
    if (said.length === 1 && more <= 0) return said[0]!;
    return `${said.map((m) => m.replace(/\.$/, "")).join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
  }
  const code = (e as { code?: string } | null)?.code;
  if (code === "P0002") return "That record no longer exists";
  if (code && SAFE_CODES.has(code) && e instanceof Error) return e.message;
  if (code === "23503") return "That record no longer exists";
  if (code === "23514") return checkMessage((e as { constraint?: string } | null)?.constraint);
  if (code === "23505") return "That already exists";
  console.error(e);
  return "Something went wrong. Try again";
}
