/** 0.084 → "8.4%", 0.2 → "20%", 0 → "0%". One decimal under 10%, none above. */
export function pctText(rate: number): string {
  const p = rate * 100;
  return `${p < 10 ? String(Math.round(p * 10) / 10) : String(Math.round(p))}%`;
}

/** Cents as the spend list reads them: a dollar figure from one dollar up, "0.31¢" below it. */
export function centsText(cents: number): string {
  if (cents >= 100) return "$" + (cents / 100).toFixed(2);
  return `${cents.toFixed(2)}¢`;
}
