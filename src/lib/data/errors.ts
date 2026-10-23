import { ZodError } from "zod";
import { UserError } from "./mutations";

/** Postgres error codes our own SQL functions raise on purpose; their messages are written for Isaac. */
const SAFE_CODES = new Set(["22023", "P0002"]);

export function toActionError(e: unknown): string {
  if (e instanceof UserError) return e.message;
  if (e instanceof ZodError) return e.issues[0]?.message ?? "That doesn't look right";
  const code = (e as { code?: string } | null)?.code;
  if (code === "P0002") return "That record no longer exists";
  if (code && SAFE_CODES.has(code) && e instanceof Error) return e.message;
  if (code === "23503") return "That record no longer exists";
  if (code === "23514") return "One of those values isn't allowed";
  if (code === "23505") return "That already exists";
  console.error(e);
  return "Something went wrong — try again";
}
