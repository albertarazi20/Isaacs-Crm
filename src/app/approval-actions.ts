"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { AdvanceResult } from "@/lib/approvals/engine";
import {
  addApprovalStep,
  clearApprovalDesign,
  closeApproval,
  createApproval,
  editApproval,
  markPitched,
  pauseApprovalEmails,
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
  approvalSchema,
  approvalSettingsSchema,
  closeSchema,
  delaySchema,
  designSchema,
  phoneSchema,
} from "@/lib/approvals/schemas";
import { CAN } from "@/lib/auth/roles";
import { advanceApprovalSafely } from "@/lib/system/approvals";
import { requireRole, requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { settingsChange, shopSnapshot } from "@/lib/settings/securityLog";
import { recordAuditHere } from "@/lib/system/audit";

const ctxFor = (userId: string) => ({ userId, now: new Date(), appUrl: env().APP_URL });

function done<T>(data: T): ActionResult<T> {
  revalidatePath("/", "layout");
  return { ok: true, data };
}

/** "Got an approval": on the Open approvals page, and the first email on its way. */
export async function createApprovalAction(
  input: unknown,
): Promise<ActionResult<{ approvalId: string; first: AdvanceResult | null }>> {
  const session = await requireSession();
  try {
    const parsed = approvalSchema.parse(input);
    const ctx = ctxFor(session.userId);
    const { approvalId, started } = await db.withUser(session.userId, (q) =>
      createApproval(q, parsed, ctx),
    );
    // the first email: on the owner connection, after the approval is committed under the rep's own row security
    const first = started ? await advanceApprovalSafely(db, approvalId, ctx) : null;
    return done({ approvalId, first });
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
