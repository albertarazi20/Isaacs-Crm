/** 1st, 2nd, 3rd, 11th, 22nd. */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** 1.34, 1.4 → "1.40", 1.345 → "1.345". Factor rates are quoted to at least two decimals. */
export function factorText(f: number): string {
  const s = f.toFixed(3);
  return s.endsWith("0") ? s.slice(0, -1) : s;
}
