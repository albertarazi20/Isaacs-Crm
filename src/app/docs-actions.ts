"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { userContext } from "@/lib/data/queries";
import { id } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { DOC_KINDS } from "@/lib/docs/label";
import { documentStore } from "@/lib/docs/storage";
import {
  clientFreshness,
  deleteDocument,
  listDocuments,
  mintDownloadLink,
  mintUploadSession,
  relabelDocument,
  wantedFor,
  type DocumentRow,
} from "@/lib/docs/upload";
import type { Freshness } from "@/lib/docs/freshness";
import { env } from "@/lib/env";

const period = z
  .string()
  .regex(/^\d{4}-\d{2}-01$/)
  .nullable()
  .default(null);

/** A two-hour upload link for this merchant: copy it, or text it while they are on the phone. */
export async function mintUploadLinkAction(
  input: unknown,
): Promise<ActionResult<{ url: string; expiresAt: string }>> {
  const session = await requireSession();
  try {
    const i = z.object({ clientId: id, dealId: id.nullable().default(null) }).parse(input);
    const data = await db.withUser(session.userId, async (q) => {
      const { today } = await userContext(q);
      const wanted = await wantedFor(q, i.clientId, today);
      const m = await mintUploadSession(q, { ...i, wanted, createdBy: session.userId });
      return { url: `${env().APP_URL}/upload/${m.token}`, expiresAt: m.expiresAt };
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function listDocumentsAction(
  input: unknown,
): Promise<ActionResult<{ documents: DocumentRow[]; freshness: Freshness }>> {
  const session = await requireSession();
  try {
    const i = z.object({ clientId: id }).parse(input);
    const data = await db.withUser(session.userId, async (q) => {
      const { today } = await userContext(q);
      return {
        documents: await listDocuments(q, i.clientId),
        freshness: await clientFreshness(q, i.clientId, today),
      };
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function relabelDocumentAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const i = z.object({ documentId: id, kind: z.enum(DOC_KINDS), period }).parse(input);
    await db.withUser(session.userId, (q) =>
      relabelDocument(q, i.documentId, i.kind, i.period, session.userId),
    );
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function deleteDocumentAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const i = z.object({ documentId: id }).parse(input);
    await db.withUser(session.userId, (q) =>
      deleteDocument(q, documentStore(env()), i.documentId, session.userId),
    );
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** An expiring, watermarked download link for a lender (or anyone outside the app). */
export async function mintLenderLinkAction(
  input: unknown,
): Promise<ActionResult<{ url: string; expiresAt: string }>> {
  const session = await requireSession();
  try {
    const i = z
      .object({
        documentId: id,
        lenderId: id.nullable().default(null),
        lenderName: z.string().trim().max(80).default(""),
        minutes: z.coerce
          .number()
          .int()
          .min(15)
          .max(7 * 24 * 60)
          .default(120),
      })
      .parse(input);
    const data = await db.withUser(session.userId, async (q) => {
      const m = await mintDownloadLink(q, {
        documentId: i.documentId,
        createdBy: session.userId,
        lenderId: i.lenderId,
        watermark: i.lenderName ? `Prepared for ${i.lenderName}` : "Confidential",
        minutes: i.minutes,
      });
      return { url: `${env().APP_URL}/d/${m.token}`, expiresAt: m.expiresAt };
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
