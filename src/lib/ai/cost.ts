/** List prices per million tokens, for the cost column of the AI run log. */
const PRICE: Record<string, { in: number; out: number }> = {
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
  "claude-fable-5-2": { in: 8, out: 40 },
};

export function costCents(model: string, inTok: number, outTok: number): number {
  const p = PRICE[model] ?? PRICE["claude-opus-5-5"]!;
  return ((inTok * p.in + outTok * p.out) / 1_000_000) * 100;
}
