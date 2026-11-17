"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/server";
import { db, type Db } from "@/lib/db";
import { toActionError } from "@/lib/data/errors";
import type { ActionResult } from "@/lib/data/types";
import { deleteSnippet, saveMessageSettings, saveSnippet } from "@/lib/messaging/mutations";
import {
  getMessagingContext,
  listSnippets,
  type MessagingContext,
  type SnippetRow,
} from "@/lib/messaging/queries";
import {
  messageSettingsSchema,
  messagingContextSchema,
  snippetIdSchema,
  snippetSchema,
} from "@/lib/messaging/schemas";

async function run<T>(
  fn: (q: Db) => Promise<T>,
  opts: { revalidate: boolean },
): Promise<ActionResult<T>> {
  const session = await requireSession();
  try {
    const data = await db.withUser(session.userId, fn);
    if (opts.revalidate) revalidatePath("/settings");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Signature, application link, saved snippets and this merchant's ask — what the Text and Email dialogs fill from. */
export async function getMessagingContextAction(
  input: unknown,
): Promise<ActionResult<MessagingContext>> {
  return run((q) => getMessagingContext(q, messagingContextSchema.parse(input).clientId), {
    revalidate: false,
  });
}

export async function saveMessageSettingsAction(input: unknown): Promise<ActionResult<null>> {
  return run(
    async (q) => {
      await saveMessageSettings(q, messageSettingsSchema.parse(input));
      return null;
    },
    { revalidate: true },
  );
}

/** Returns the whole list so the settings card can show it without a second round trip. */
export async function saveSnippetAction(input: unknown): Promise<ActionResult<SnippetRow[]>> {
  return run(
    async (q) => {
      await saveSnippet(q, snippetSchema.parse(input));
      return listSnippets(q);
    },
    { revalidate: true },
  );
}

export async function deleteSnippetAction(input: unknown): Promise<ActionResult<SnippetRow[]>> {
  return run(
    async (q) => {
      await deleteSnippet(q, snippetIdSchema.parse(input).id);
      return listSnippets(q);
    },
    { revalidate: true },
  );
}
