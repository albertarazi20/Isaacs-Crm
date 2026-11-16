import type { z } from "zod";
import type { Db } from "../db";
import { UserError } from "../data/mutations";
import type {
  askManagerSchema,
  closeDealSchema,
  dealNoteSchema,
  kickBackSchema,
  submitToOpsSchema,
} from "./schemas";
import type { DealRow } from "./types";

type Row = Omit<DealRow, "status">;

export async function submitToOps(q: Db, input: z.output<typeof submitToOpsSchema>): Promise<Row> {
  const { rows } = await q.query<Row>("select * from submit_to_ops($1, $2, $3, $4, $5)", [
    input.clientId,
    input.kind,
    input.requested ?? null,
    input.useOfFunds,
    input.note,
  ]);
  const d = rows[0];
  if (!d) throw new Error("submit_to_ops returned no row");
  return d;
}

export async function kickBack(q: Db, input: z.output<typeof kickBackSchema>): Promise<Row> {
  const { rows } = await q.query<Row>("select * from kick_back_deal($1, $2, $3)", [
    input.dealId,
    input.reason,
    input.note,
  ]);
  const d = rows[0];
  if (!d) throw new Error("kick_back_deal returned no row");
  return d;
}

export async function markSent(q: Db, dealId: string): Promise<Row> {
  const { rows } = await q.query<Row>("select * from mark_deal_sent($1)", [dealId]);
  const d = rows[0];
  if (!d) throw new Error("mark_deal_sent returned no row");
  return d;
}

export async function closeDeal(q: Db, input: z.output<typeof closeDealSchema>): Promise<Row> {
  const { rows } = await q.query<Row>("select * from close_deal($1, $2, $3)", [
    input.dealId,
    input.outcome,
    input.reason,
  ]);
  const d = rows[0];
  if (!d) throw new Error("close_deal returned no row");
  return d;
}

/** The four free-text fields on a deal. Column name comes from a closed enum, never from the caller. */
export async function setDealNote(q: Db, input: z.output<typeof dealNoteSchema>): Promise<void> {
  const sql = {
    rep_note: "update deals set rep_note = $2 where id = $1",
    manager_note: "update deals set manager_note = $2 where id = $1",
    ops_note: "update deals set ops_note = $2 where id = $1",
    blocker: "update deals set blocker = $2 where id = $1",
  }[input.field];
  const res = await q.query(sql, [input.dealId, input.text]);
  if (res.rowCount === 0) throw new UserError("That deal no longer exists");
}

/** Ask a manager (S2-14): every manager gets an alert with the question and the deal's context. Returns how many. */
export async function askManager(q: Db, input: z.output<typeof askManagerSchema>): Promise<number> {
  const { rows } = await q.query<{ n: number }>("select ask_manager($1, $2) as n", [
    input.dealId,
    input.question,
  ]);
  return rows[0]?.n ?? 0;
}
