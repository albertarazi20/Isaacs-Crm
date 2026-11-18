import type { Db } from "../../db";
import { addApprovalStep, saveApprovalDesign, setApprovalDelay } from "../mutations";
import { STOCK_DESIGNS } from "../stock";

export interface StockLoadResult {
  /** The slots whose design, subject or file name changed. */
  replaced: number[];
  /** Slots added to the sequence because it had fewer than four emails. */
  added: number[];
  /** The follow-ups whose wait changed. */
  delays: number[];
}

interface SlotRow {
  step: number;
  subject: string;
  html: string;
  file_name: string;
  delay_hours: number;
}

/**
 * Put the Selective Capital designs in slots 1 to 4 with their subject lines and waits. Every write goes through the
 * settings' own save path (`saveApprovalDesign`, so the design check, the "unsubscribe link is required" rule and the
 * recall of an email queued from the old design all run; `setApprovalDelay`; `addApprovalStep` when a slot is missing),
 * all in the caller's one transaction: a refusal anywhere leaves every slot as it was. A slot that already holds
 * exactly the design is not written again, so loading twice changes nothing (and recalls nothing). Slots past the
 * fourth, the daytime window and the on/off switch are not touched.
 */
export async function loadStockDesigns(q: Db, userId: string): Promise<StockLoadResult> {
  const read = async () =>
    (
      await q.query<SlotRow>(
        "select step, subject, html, file_name, delay_hours from approval_emails order by step for update",
      )
    ).rows;
  let rows = await read();
  const added: number[] = [];
  for (const d of STOCK_DESIGNS) {
    if (rows.some((r) => r.step === d.step)) continue;
    added.push(await addApprovalStep(q, userId));
    rows = await read();
  }
  const replaced: number[] = [];
  const delays: number[] = [];
  for (const d of STOCK_DESIGNS) {
    const now = rows.find((r) => r.step === d.step);
    if (!now) throw new Error(`approval email slot ${d.step} is missing`);
    if (now.html !== d.html || now.subject !== d.subject || now.file_name !== d.fileName) {
      await saveApprovalDesign(
        q,
        { step: d.step, subject: d.subject, html: d.html, fileName: d.fileName },
        userId,
      );
      replaced.push(d.step);
    }
    // the first email goes right away: its wait is never used, so it is left as it is
    if (d.step > 1 && now.delay_hours !== d.delayHours) {
      await setApprovalDelay(q, d.step, d.delayHours, userId);
      delays.push(d.step);
    }
  }
  return { replaced, added, delays };
}
