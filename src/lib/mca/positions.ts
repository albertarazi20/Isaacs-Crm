export interface PositionInput {
  positionNo: number;
  funderName: string;
  fundedAmountCents: number;
  balanceCents: number;
  /** Total owed back at funding (amount × factor). Without it paid-down % is unknowable, so we say so. */
  paybackCents?: number | null;
}

export interface StackRollup {
  count: number;
  totalBalanceCents: number;
  totalFundedCents: number;
  /** Null when no position has a payback figure — never guess a percentage. */
  paidDownPct: number | null;
  /** Highest position number — what the next funder would be stepping into. */
  deepestPosition: number;
  /** The position a new advance would take. */
  nextPosition: number;
}

export function stackRollup(positions: readonly PositionInput[]): StackRollup {
  const withPayback = positions.filter((p) => (p.paybackCents ?? 0) > 0);
  const paybackSum = withPayback.reduce((s, p) => s + (p.paybackCents ?? 0), 0);
  const balanceSum = withPayback.reduce((s, p) => s + p.balanceCents, 0);
  const deepest = positions.reduce((mx, p) => Math.max(mx, p.positionNo), 0);
  return {
    count: positions.length,
    totalBalanceCents: positions.reduce((s, p) => s + p.balanceCents, 0),
    totalFundedCents: positions.reduce((s, p) => s + p.fundedAmountCents, 0),
    paidDownPct:
      paybackSum > 0
        ? Math.round(Math.min(100, Math.max(0, (1 - balanceSum / paybackSum) * 100)) * 10) / 10
        : null,
    deepestPosition: deepest,
    nextPosition: deepest + 1,
  };
}
