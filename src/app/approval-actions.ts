"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { AdvanceResult } from "@/lib/approvals/engine";
import { stopEmailsForGood, stopEmailsSchema, turnEmailsBackOn } from "@/lib/approvals/hardStop";
import {
  approvalWithFirstSchema,
  parseSentAt,
  recordFirstSchema,
} from "@/lib/approvals/manualFirst";
import {
  addApprovalStep,
  clearApprovalDesign,
  closeApproval,
  createApproval,
  editApproval,
  markPitched,
  pauseApprovalEmails,
  recordFirstEmailSent,
  removeLastApprovalStep,
  reopenApproval,
  resumeApprovalEmails,
  saveApprovalDesign,
  setApprovalDelay,
  setApprovalSettings,
  setMyPhone,
} from "@/lib/approvals/mutations";
import {
  approvalEditSchema,
  approvalIdSchema,
  approvalSettingsSchema,
  closeSchema,
  delaySchema,
  designSchema,
  phoneSchema,
} from "@/lib/approvals/schemas";
import { loadStockDesigns, type StockLoadResult } from "@/lib/approvals/stock/load";
import { CAN } from "@/lib/auth/roles";
import { advanceApprovalSafely } from "@/lib/system/approvals";
import { requireRole, requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { settingsChange, shopSnapshot } from "@/lib/settings/securityLog";
import { recordAuditHere, requestMeta } from "@/lib/system/audit";

const ctxFor = (userId: string) => ({ userId, now: new Date(), appUrl: env().APP_URL });

function done<T>(data: T): ActionResult<T> {
  revalidatePath("/", "layout");
  return { ok: true, data };
}

/**
 * "Got an approval": on the Open approvals page, and the first email on its way. `firstEmail: "mine"` (with an
 * optional `sentAt`): the rep already sent it themselves, so step 1 is recorded as sent and nothing goes on the
 * outbox; the follow-ups then run on their own.
 */
export async function createApprovalAction(
  input: unknown,
): Promise<
  ActionResult<{ approvalId: string; first: AdvanceResult | null; emailsStopped: boolean }>
> {
  const session = await requireSession();
  try {
    const parsed = approvalWithFirstSchema.parse(input);
    const ctx = ctxFor(session.userId);
    const firstSentAt =
      parsed.firstEmail === "mine" ? (parseSentAt(parsed.sentAt) ?? ctx.now) : null;
    const { approvalId, started, emailsStopped } = await db.withUser(session.userId, (q) =>
      createApproval(q, { ...parsed, firstSentAt }, ctx),
    );
    // the first email: on the owner connection, after the approval is committed under the rep's own row security
    const first = started ? await advanceApprovalSafely(db, approvalId, ctx) : null;
    return done({ approvalId, first, emailsStopped });
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function editApprovalAction(
  input: unknown,
): Promise<ActionResult<{ approvalId: string }>> {
  const session = await requireSession();
  try {
    const parsed = approvalEditSchema.parse(input);
    const ctx = ctxFor(session.userId);
    const id = await db.withUser(session.userId, (q) => editApproval(q, parsed, ctx));
    await advanceApprovalSafely(db, id, ctx);
    return done({ approvalId: id });
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function pitchedAction(input: unknown): Promise<ActionResult<{ business: string }>> {
  const session = await requireSession();
  try {
    const { approvalId } = approvalIdSchema.parse(input);
    const data = await db.withUser(session.userId, (q) =>
      markPitched(q, approvalId, ctxFor(session.userId)),
    );
    return done(data);
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function closeApprovalAction(
  input: unknown,
): Promise<ActionResult<{ business: string }>> {
  const session = await requireSession();
  try {
    const { approvalId, reason } = closeSchema.parse(input);
    const data = await db.withUser(session.userId, (q) =>
      closeApproval(q, approvalId, reason, ctxFor(session.userId)),
    );
    return done(data);
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** `restore`: the Undo in the toast, which puts the emails back as they were. */
export async function reopenApprovalAction(
  input: unknown,
): Promise<ActionResult<{ approvalId: string }>> {
  const session = await requireSession();
  try {
    const { approvalId, restore } = approvalIdSchema
      .extend({ restore: z.boolean().default(false) })
      .parse(input);
    const ctx = ctxFor(session.userId);
    const { running } = await db.withUser(session.userId, (q) =>
      reopenApproval(q, approvalId, ctx, restore),
    );
    if (running) await advanceApprovalSafely(db, approvalId, ctx);
    return done({ approvalId });
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function pauseApprovalAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const { approvalId } = approvalIdSchema.parse(input);
    await db.withUser(session.userId, (q) => pauseApprovalEmails(q, approvalId));
    return done(null);
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function resumeApprovalAction(input: unknown): Promise<ActionResult<AdvanceResult>> {
  const session = await requireSession();
  try {
    const { approvalId } = approvalIdSchema.parse(input);
    await db.withUser(session.userId, (q) => resumeApprovalEmails(q, approvalId));
    const data = await advanceApprovalSafely(db, approvalId, ctxFor(session.userId));
    return done(data);
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** "I already sent the first email", on an approval created with the emails held. */
export async function recordFirstEmailAction(
  input: unknown,
): Promise<ActionResult<{ at: string; next: AdvanceResult }>> {
  const session = await requireSession();
  try {
    const { approvalId, sentAt } = recordFirstSchema.parse(input);
    const ctx = ctxFor(session.userId);
    const { at } = await db.withUser(session.userId, (q) =>
      recordFirstEmailSent(q, approvalId, parseSentAt(sentAt), ctx),
    );
    const next = await advanceApprovalSafely(db, approvalId, ctx);
    return done({ at, next });
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/**
 * "Stop emails for good": no more automated email to this merchant (approvals, sequences, nudges, the welcome email,
 * blasts). A rep for their own merchants, a manager for any: the database function decides.
 */
export async function stopEmailsAction(
  input: unknown,
): Promise<ActionResult<Awaited<ReturnType<typeof stopEmailsForGood>>>> {
  const session = await requireSession();
  try {
    const { clientId } = stopEmailsSchema.parse(input);
    const data = await stopEmailsForGood(
      db,
      { userId: session.userId, email: session.email },
      clientId,
      await requestMeta(),
    );
    return done(data);
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Managers: turn a merchant's emails back on. Nothing restarts by itself. */
export async function turnEmailsBackOnAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const { clientId } = stopEmailsSchema.parse(input);
    await turnEmailsBackOn(
      db,
      { userId: session.userId, email: session.email },
      clientId,
      await requestMeta(),
    );
    return done(null);
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

// ── Settings ───────────────────────────────────────────────────────────────────────────────────────

export async function saveApprovalDesignAction(
  input: unknown,
): Promise<ActionResult<{ warnings: string[]; subject: string }>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const parsed = designSchema.parse(input);
    const data = await db.withUser(session.userId, (q) =>
      saveApprovalDesign(q, parsed, session.userId),
    );
    return done(data);
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function clearApprovalDesignAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const { step } = z.object({ step: z.coerce.number().int().min(1).max(6) }).parse(input);
    await db.withUser(session.userId, (q) => clearApprovalDesign(q, step, session.userId));
    return done(null);
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/**
 * "Load the Selective Capital designs": the four ready-made emails into slots 1 to 4, with their subjects and waits,
 * through the same save path as a design saved by hand. Managers only.
 */
export async function loadStockDesignsAction(): Promise<ActionResult<StockLoadResult>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const data = await db.withUser(session.userId, (q) => loadStockDesigns(q, session.userId));
    if (data.replaced.length > 0 || data.delays.length > 0 || data.added.length > 0)
      await recordAuditHere({
        kind: "settings_approvals_saved",
        userId: session.userId,
        email: session.email,
        detail: { changed: ["approval_emails"], values: {} },
      });
    return done(data);
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function setApprovalDelayAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const { step, hours } = delaySchema.parse(input);
    await db.withUser(session.userId, (q) => setApprovalDelay(q, step, hours, session.userId));
    return done(null);
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function addApprovalStepAction(): Promise<ActionResult<{ step: number }>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const step = await db.withUser(session.userId, (q) => addApprovalStep(q, session.userId));
    return done({ step });
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function removeApprovalStepAction(): Promise<ActionResult<null>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    await db.withUser(session.userId, (q) => removeLastApprovalStep(q));
    return done(null);
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function setApprovalSettingsAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const parsed = approvalSettingsSchema.parse(input);
    const { before, after } = await db.withUser(session.userId, async (q) => {
      const was = await shopSnapshot(q);
      await setApprovalSettings(q, parsed);
      return { before: was, after: await shopSnapshot(q) };
    });
    await recordAuditHere({
      kind: "settings_approvals_saved",
      userId: session.userId,
      email: session.email,
      detail: settingsChange(before, after),
    });
    return done(null);
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function setMyPhoneAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const { phone } = phoneSchema.parse(input);
    await db.withUser(session.userId, (q) => setMyPhone(q, session.userId, phone));
    return done(null);
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
