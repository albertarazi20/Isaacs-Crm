"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CAN, requireRole } from "@/lib/auth/server";
import { ROLES } from "@/lib/auth/roles";
import { toActionError } from "@/lib/data/errors";
import { id } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { listTeam, type TeamMember } from "@/lib/trust/queries";

export async function listTeamAction(): Promise<ActionResult<TeamMember[]>> {
  try {
    const session = await requireRole(CAN.manageTeam);
    const data = await db.withUser(session.userId, (q) => listTeam(q));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** A manager adds a person by name and email; they sign in with their selectivecap.com Google account. */
export async function addTeamMemberAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await requireRole(CAN.manageTeam);
    const i = z
      .object({
        email: z.string().trim().email(),
        name: z.string().trim().min(1).max(80),
        role: z.enum(ROLES),
      })
      .parse(input);
    const row = await db.withUser(session.userId, async (q) => {
      const { rows } = await q.query<{ id: string }>("select id from add_team_member($1, $2, $3)", [
        i.email,
        i.name,
        i.role,
      ]);
      return rows[0];
    });
    if (!row) throw new Error("add_team_member returned nothing");
    revalidatePath("/", "layout");
    return { ok: true, data: { id: row.id } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Change a role, or switch a login off and on. Offboarding (moving the book) is its own action. */
export async function setTeamMemberAction(input: unknown): Promise<ActionResult<null>> {
  try {
    const session = await requireRole(CAN.manageTeam);
    const i = z.object({ userId: id, role: z.enum(ROLES), active: z.boolean() }).parse(input);
    await db.withUser(session.userId, (q) =>
      q.query("select set_team_member($1, $2, $3)", [i.userId, i.role, i.active]),
    );
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
