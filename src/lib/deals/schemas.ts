import { z } from "zod";
import { money, line, id } from "../data/schemas";
import { DEAL_KINDS, KICKBACK_REASONS, OUTCOMES } from "./types";

export const submitToOpsSchema = z.object({
  clientId: id,
  kind: z.enum(DEAL_KINDS).default("new"),
  requested: money.optional(),
  useOfFunds: line(500).default(""),
  note: line(2000).default(""),
});

export const kickBackSchema = z
  .object({
    dealId: id,
    reason: z.enum(KICKBACK_REASONS),
    note: line(2000).default(""),
  })
  .refine((v) => v.reason !== "other" || v.note.trim() !== "", {
    message: "Say what is wrong when the reason is Other",
    path: ["note"],
  });

export const dealIdSchema = z.object({ dealId: id });

export const closeDealSchema = z.object({
  dealId: id,
  outcome: z.enum(OUTCOMES).refine((o) => o !== "open" && o !== "funded", {
    message: "Use FUND to mark a deal funded",
  }),
  reason: line(500).default(""),
});

export const dealNoteSchema = z.object({
  dealId: id,
  field: z.enum(["rep_note", "manager_note", "ops_note", "blocker"]),
  text: line(5000),
});

export const askManagerSchema = z.object({
  dealId: id,
  question: line(2000).refine((s) => s.trim() !== "", { message: "Say what you want to ask" }),
});

export const reshopSchema = z.object({ clientId: id });
