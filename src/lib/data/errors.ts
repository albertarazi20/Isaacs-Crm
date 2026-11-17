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
  return "One of those values isn't allowed — check the amounts and dates";
}

export function toActionError(e: unknown): string {
  if (e instanceof UserError) return e.message;
  if (e instanceof ZodError) return e.issues[0]?.message ?? "That doesn't look right";
  const code = (e as { code?: string } | null)?.code;
  if (code === "P0002") return "That record no longer exists";
  if (code && SAFE_CODES.has(code) && e instanceof Error) return e.message;
  if (code === "23503") return "That record no longer exists";
  if (code === "23514") return checkMessage((e as { constraint?: string } | null)?.constraint);
  if (code === "23505") return "That already exists";
  console.error(e);
  return "Something went wrong — try again";
}
