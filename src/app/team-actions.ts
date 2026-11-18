"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CAN, requireRole } from "@/lib/auth/server";
import { OFFERED_ROLES, ROLES } from "@/lib/auth/roles";
import { toActionError } from "@/lib/data/errors";
import { id } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { listTeam, type TeamMember } from "@/lib/settings/team";
import { recordAuditHere } from "@/lib/system/audit";

export async function listTeamAction(): Promise<ActionResult<TeamMember[]>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const data = await db.withUser(session.userId, (q) => listTeam(q));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** A manager adds a person by name and email; they sign in with their selectivecap.com Google account. */
export async function addTeamMemberAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const i = z
      .object({
        email: z.string().trim().email(),
        name: z.string().trim().min(1).max(80),
        role: z.enum(OFFERED_ROLES),
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
    await recordAuditHere({
      kind: "team_added",
      userId: session.userId,
      email: session.email,
      detail: { target_email: i.email.toLowerCase(), role: i.role },
    });
    revalidatePath("/", "layout");
    return { ok: true, data: { id: row.id } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Change a role, or switch a login off and on. */
export async function setTeamMemberAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const i = z.object({ userId: id, role: z.enum(ROLES), active: z.boolean() }).parse(input);
    const { before, after } = await db.withUser(session.userId, async (q) => {
      const read = () =>
        q.query<{ email: string; role: string; active: boolean }>(
          "select email, role, active from app_users where id = $1",
          [i.userId],
        );
      const was = (await read()).rows[0];
      await q.query("select set_team_member($1, $2, $3)", [i.userId, i.role, i.active]);
      return { before: was, after: (await read()).rows[0] };
    });
    if (before && after) {
      const base = { userId: session.userId, email: session.email };
      const target = { target_email: after.email };
      if (before.role !== after.role)
        await recordAuditHere({
          ...base,
          kind: "team_role_changed",
          detail: { ...target, from: before.role, to: after.role },
        });
      if (before.active !== after.active)
        await recordAuditHere({
          ...base,
          kind: after.active ? "team_enabled" : "team_disabled",
          detail: target,
        });
      // the database ends the person's sessions when they are switched off or their role changes
      if (!after.active || before.role !== after.role)
        await recordAuditHere({
          ...base,
          kind: "session_killed",
          detail: { ...target, reason: after.active ? "role_changed" : "disabled" },
        });
    }
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
