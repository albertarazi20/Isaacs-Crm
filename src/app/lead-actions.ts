"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { UserError } from "@/lib/data/mutations";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { generateToken, hashToken, MAX_ACTIVE_TOKENS } from "@/lib/leads/token";

const labelSchema = z.object({ label: z.string().trim().min(1, "Name this connection").max(60) });
const idSchema = z.object({ id: z.string().uuid() });

/** Makes a token and returns it ONCE. Only its hash is kept. */
export async function createLeadTokenAction(
  input: unknown,
): Promise<ActionResult<{ token: string }>> {
  const session = await requireSession();
  try {
    const { label } = labelSchema.parse(input);
    const token = generateToken();
    await db.withUser(session.userId, async (q) => {
      const { rows } = await q.query<{ n: number }>(
        "select count(*)::int as n from lead_tokens where revoked_at is null",
      );
      if ((rows[0]?.n ?? 0) >= MAX_ACTIVE_TOKENS)
        throw new UserError(
          `You already have ${MAX_ACTIVE_TOKENS} active connections. Turn one off first`,
        );
      await q.query(
        "insert into lead_tokens (user_id, label, token_hash) values (app.current_user_id(), $1, $2)",
        [label, hashToken(token)],
      );
    });
    revalidatePath("/settings");
    return { ok: true, data: { token } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Switches a token off for good. The app that was using it starts getting "not valid" at once. */
export async function revokeLeadTokenAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const { id } = idSchema.parse(input);
    const res = await db.withUser(session.userId, (q) =>
      q.query("update lead_tokens set revoked_at = now() where id = $1 and revoked_at is null", [
        id,
      ]),
    );
    if (res.rowCount === 0) throw new UserError("That connection is already off");
    revalidatePath("/settings");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
