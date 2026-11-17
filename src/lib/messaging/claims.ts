/**
 * The claim checker (plan §13.4): words an MCA shop must not put in front of a merchant unless they are true.
 * Pure, so the manager's template approval and the outbox worker run the same check without a database.
 *
 * Two uses:
 *   * a template, with no merchant in mind (`ctx` omitted): the California rule needs a merchant and is skipped;
 *   * an automated send to one merchant (`ctx` given): a factor-rate quote to a California merchant is held
 *     (California wants the full disclosure first).
 * "Approved" language is refused in both: nothing in this system approves anyone, so it can never be true.
 * One-to-one mail a person writes is never checked: this is for what the engine sends on its own.
 */

export interface ClaimContext {
  /** The merchant's state as stored ("CA", "ca", "California"). */
  state: string;
}

export interface ClaimCheck {
  ok: boolean;
  /** Each failing rule, in words a manager can act on. Empty when ok. */
  reasons: string[];
}

const APPROVED = /\b(pre-?\s?approved|pre-?\s?approval|approved|approval)\b/i;
const GUARANTEED = /\bguarantee[ds]?\b/i;
const NO_FEES = /\b(no|zero|without)\s+(any\s+)?(up-?\s?front\s+|hidden\s+)?fees?\b|\bfee-free\b/i;
const LOAN = /\bloans?\b/i;
const RATE_QUOTE = /\b(factor|buy|sell)\s*rate\b|\b1\.\d{2,3}\b/i;

const isCalifornia = (state: string): boolean => {
  const s = state.trim().toLowerCase();
  return s === "ca" || s === "california";
};

export function checkClaims(text: string, ctx?: ClaimContext): ClaimCheck {
  const reasons: string[] = [];
  if (APPROVED.test(text))
    reasons.push(
      'Says "approved": nothing is approved at this stage, so automated mail cannot say it',
    );
  if (GUARANTEED.test(text)) reasons.push('Says "guaranteed": nothing in funding is guaranteed');
  if (NO_FEES.test(text)) reasons.push("Promises no fees: leave fees out of automated mail");
  if (LOAN.test(text)) reasons.push('Says "loan": an advance is not a loan');
  if (ctx && isCalifornia(ctx.state) && RATE_QUOTE.test(text))
    reasons.push(
      "Quotes a rate to a California merchant: California requires the full disclosure before a rate is quoted",
    );
  return { ok: reasons.length === 0, reasons };
}
