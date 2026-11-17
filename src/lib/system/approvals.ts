import { advanceApproval, type AdvanceResult } from "../approvals/engine";
import type { DbAccess } from "../db";

/**
 * The approval emails' system side: the engine runs on the owner connection so it sees every step already sent,
 * whichever rep's mailbox sent it (row security would hide another rep's rows and the step would look unsent).
 */

/** Move one approval along right after a person changed it (marked, resumed, edited). */
export async function advanceApprovalNow(
  db: DbAccess,
  approvalId: string,
  opts: { now: Date; appUrl: string },
): Promise<AdvanceResult> {
  return db.withSystem((q) => advanceApproval(q, approvalId, opts));
}

export interface ApprovalRunSummary {
  checked: number;
  queued: number;
  stopped: number;
  finished: number;
  errors: number;
  /** Left for the next run: the time budget ran out first. */
  deferred: number;
}

/**
 * Every few minutes (the outbox cron, before it sends): move every running approval along, each in its own
 * transaction so one bad row is one error, not a stopped run. Time-boxed so the send that follows still has its time.
 */
export async function runApprovalEmails(args: {
  db: DbAccess;
  appUrl: string;
  now?: Date;
  budgetMs?: number;
}): Promise<ApprovalRunSummary> {
  const now = args.now ?? new Date();
  const started = Date.now();
  const budget = args.budgetMs ?? 20_000;
  const summary: ApprovalRunSummary = {
    checked: 0,
    queued: 0,
    stopped: 0,
    finished: 0,
    errors: 0,
    deferred: 0,
  };
  const ids = await args.db.withSystem(
    async (q) =>
      (
        await q.query<{ id: string }>(
          "select id from approvals where status = 'open' and emails = 'running' order by next_email_at nulls first, created_at",
        )
      ).rows,
  );
  for (const [i, { id }] of ids.entries()) {
    if (Date.now() - started > budget) {
      summary.deferred = ids.length - i;
      console.warn(`approval emails: ${summary.deferred} left for the next run (time budget)`);
      break;
    }
    summary.checked += 1;
    try {
      const r = await advanceApprovalNow(args.db, id, { now, appUrl: args.appUrl });
      if (r.kind === "queued") summary.queued += 1;
      else if (r.kind === "stopped") summary.stopped += 1;
      else if (r.kind === "finished") summary.finished += 1;
    } catch (e) {
      summary.errors += 1;
      console.error(`approval ${id}:`, e);
    }
  }
  return summary;
}
