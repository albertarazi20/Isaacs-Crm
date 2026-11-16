"use server";

import { revalidatePath } from "next/cache";
import { CAN, requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import type { ActionResult } from "@/lib/data/types";
import { db, type Db } from "@/lib/db";
import { getCard } from "@/lib/data/queries";
import type { ClientCard } from "@/lib/data/types";
import { getClientFundersData } from "@/lib/funders/queries";
import type { ClientFundersData } from "@/lib/funders/types";
import { z } from "zod";
import { UserError } from "@/lib/data/mutations";
import { askDeal, type DealAnswer } from "@/lib/deals/ask";
import { aiFailureWords, NO_KEY_WORDS } from "@/lib/deals/aiWords";
import { env } from "@/lib/env";
import * as m from "@/lib/deals/mutations";
import { reshopCandidates, startReshop, type ReshopCandidate } from "@/lib/deals/reshop";
import * as s from "@/lib/deals/schemas";
import type { Role } from "@/lib/auth/roles";

async function run<T>(
  fn: (q: Db) => Promise<T>,
  allowed: (r: Role) => boolean = () => true,
): Promise<ActionResult<T>> {
  const session = await requireSession();
  try {
    if (!allowed(session.role)) throw new UserError("Your account can't do that");
    const data = await db.withUser(session.userId, fn);
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export type SendContext = ClientFundersData & { card: ClientCard };
const sendContextSchema = z.object({ clientId: z.string().uuid() });

/**
 * What the board's "Send to lenders" needs to open the lender picker for a deal it knows only by id (P2-39):
 * the merchant's card, the funder list and this merchant's earlier submissions. A read, so no revalidate.
 */
export async function sendContextAction(input: unknown): Promise<ActionResult<SendContext>> {
  const session = await requireSession();
  try {
    if (!CAN.runOps(session.role)) throw new UserError("Your account can't do that");
    const { clientId } = sendContextSchema.parse(input);
    const data = await db.withUser(session.userId, async (q) => {
      const card = await getCard(q, clientId);
      if (!card) throw new UserError("That merchant isn't in your view");
      return { card, ...(await getClientFundersData(q, clientId)) };
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function submitToOpsAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return run(
    async (q) => ({ id: (await m.submitToOps(q, s.submitToOpsSchema.parse(input))).id }),
    CAN.workLeads,
  );
}

export async function kickBackDealAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.kickBack(q, s.kickBackSchema.parse(input));
    return null;
  }, CAN.runOps);
}

export async function markDealSentAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.markSent(q, s.dealIdSchema.parse(input).dealId);
    return null;
  }, CAN.runOps);
}

export async function closeDealAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.closeDeal(q, s.closeDealSchema.parse(input));
    return null;
  });
}

export async function setDealNoteAction(input: unknown): Promise<ActionResult<null>> {
  const i = s.dealNoteSchema.safeParse(input);
  const field = i.success ? i.data.field : null;
  // The page hides the editors; the action is the real gate (a rep posting manager_note from the console).
  const allowed = (r: Role) =>
    field === "manager_note" ? CAN.manageTeam(r) : field === "ops_note" ? CAN.runOps(r) : true;
  return run(async (q) => {
    const parsed = s.dealNoteSchema.parse(input);
    return (await m.setDealNote(q, parsed), null);
  }, allowed);
}

/** Ask a manager: one click writes every manager's alert with the question and the deal's context (S2-14). */
export async function askManagerAction(
  input: unknown,
): Promise<ActionResult<{ managers: number }>> {
  return run(async (q) => ({ managers: await m.askManager(q, s.askManagerSchema.parse(input)) }));
}

/** The lenders a declined-by-all deal could go to next: rules fit, and they have not seen this merchant (S2-10). */
export async function reshopCandidatesAction(
  input: unknown,
): Promise<ActionResult<ReshopCandidate[]>> {
  const session = await requireSession();
  try {
    const { clientId } = s.reshopSchema.parse(input);
    const data = await db.withUser(session.userId, (q) => reshopCandidates(q, clientId));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** One-click reshop: close the declined deal, open a new one pre-filled, ask for the newest statement. */
export async function startReshopAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return run(
    async (q) => ({ id: (await startReshop(q, s.reshopSchema.parse(input).clientId)).id }),
    CAN.workLeads,
  );
}

// ---------- ask the deal a question (plan §7 Activity) ----------
const askSchema = z.object({
  dealId: z.string().uuid(),
  question: z
    .string()
    .min(3, "Ask a question first")
    .max(500, "Keep the question under 500 characters"),
});

/** "Where does this deal stand?" in plain words, answered from the timeline with verified citations. A read. */
export async function askDealAction(input: unknown): Promise<ActionResult<DealAnswer>> {
  const session = await requireSession();
  try {
    const i = askSchema.parse(input);
    if (!env().ANTHROPIC_API_KEY) throw new UserError(NO_KEY_WORDS);
    const data = await askDeal({
      db,
      userId: session.userId,
      dealId: i.dealId,
      question: i.question,
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: aiFailureWords(e) ?? toActionError(e) };
  }
}
