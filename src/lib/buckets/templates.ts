import type { Db } from "../db";
import { UserError } from "../data/mutations";
import { checkClaims } from "../messaging/claims";

/**
 * A manager's approval of a template is the moment the claim checker runs (S1-15): a template that says
 * "approved", "guaranteed", "no fees" or "loan" is refused with the reasons, and stays unapproved. Approval also
 * lifts a bounce-spike auto-pause (S1-7): the manager has looked at it, so the engine may send it again.
 */
export async function setTemplateApproved(
  q: Db,
  templateId: string,
  approved: boolean,
): Promise<void> {
  if (approved) {
    const tpl = (
      await q.query<{ subject: string; body: string }>(
        "select subject, body from templates where id = $1",
        [templateId],
      )
    ).rows[0];
    if (!tpl) throw new UserError("Template not found");
    const claims = checkClaims(`${tpl.subject}\n${tpl.body}`);
    if (!claims.ok)
      throw new UserError(
        `This template cannot be approved as written: ${claims.reasons.join("; ")}`,
      );
  }
  const r = await q.query(
    `update templates
        set approved = $2,
            approved_by = case when $2 then app.current_user_id() end,
            approved_at = case when $2 then now() end,
            auto_paused_at = case when $2 then null else auto_paused_at end,
            auto_pause_reason = case when $2 then '' else auto_pause_reason end
      where id = $1`,
    [templateId, approved],
  );
  if (r.rowCount === 0) throw new UserError("Template not found");
}
