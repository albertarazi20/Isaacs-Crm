"use server";

import { z } from "zod";
import { CAN } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/server";
import { loadRecommendations, type Recommendation } from "@/lib/assistant/recommendations";
import {
  listThreads,
  loadThreadForDisplay,
  type ShownItem,
  type ThreadSummary,
} from "@/lib/assistant/run";
import { toActionError } from "@/lib/data/errors";
import { UserError } from "@/lib/data/mutations";
import { userContext } from "@/lib/data/queries";
import type { ActionResult } from "@/lib/data/types";
import { openPrep, prepIsStale } from "@/lib/brain/queries";
import { db } from "@/lib/db";
import { gmailStatus } from "@/lib/system/gmail";

const idInput = z.object({ id: z.string().uuid() });

/** The person's recent conversations with the assistant (their own only: row security). */
export async function listThreadsAction(): Promise<ActionResult<ThreadSummary[]>> {
  const session = await requireSession();
  try {
    return { ok: true, data: await db.withUser(session.userId, (q) => listThreads(q)) };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function loadThreadAction(input: unknown): Promise<ActionResult<ShownItem[]>> {
  const session = await requireSession();
  try {
    const { id } = idInput.parse(input);
    const items = await db.withUser(session.userId, (q) => loadThreadForDisplay(q, id));
    if (!items) throw new UserError("That conversation is gone");
    return { ok: true, data: items };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function deleteThreadAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const { id } = idInput.parse(input);
    await db.withUser(session.userId, (q) =>
      q.query("delete from assistant_threads where id = $1", [id]),
    );
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** The workflows the assistant suggests, read from the person's own book (a manager's: the shop). */
export async function loadRecommendationsAction(): Promise<ActionResult<Recommendation[]>> {
  const session = await requireSession();
  try {
    const gmail = await gmailStatus(session.userId);
    const data = await db.withUser(session.userId, async (q) => {
      const { today } = await userContext(q);
      return loadRecommendations(q, {
        today,
        manager: CAN.seeEveryone(session.role),
        gmailConnected: gmail.connected,
      });
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Opens what the assistant prepared for the person: marks it read and returns the conversation with its buttons. */
export async function openPreparedAction(
  input: unknown,
): Promise<ActionResult<{ threadId: string; items: ShownItem[]; stale: boolean }>> {
  const session = await requireSession();
  try {
    const { id } = idInput.parse(input);
    const opened = await db.withUser(session.userId, async (q) => {
      const threadId = await openPrep(q, id);
      const items = threadId ? await loadThreadForDisplay(q, threadId) : null;
      // the buttons were made when the preparation was: if the merchant has moved on since, they are shown as earlier
      const stale = threadId ? await prepIsStale(q, id) : false;
      return threadId && items ? { threadId, items, stale } : null;
    });
    if (!opened) throw new UserError("That is no longer there");
    return { ok: true, data: opened };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
