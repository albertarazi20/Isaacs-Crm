/** Isaac types "50k" and "$75,000" and "1.2m". Everything is stored as integer cents. */
export function parseMoney(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number")
    return Number.isFinite(input) && input >= 0 ? Math.round(input * 100) : null;
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[$,\s]/g, "");
  const m = /^(\d+(?:\.\d+)?|\.\d+)([km]?)$/.exec(s);
  if (!m) return null;
  const mult = m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1;
  return Math.round(Number(m[1]) * mult * 100);
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const USD_CENTS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatMoney(
  cents: number | null | undefined,
  opts: { cents?: boolean } = {},
): string {
  if (cents === null || cents === undefined) return "—";
  return (opts.cents ? USD_CENTS : USD).format(cents / 100);
}

/** $7.5k / $1.2M — for tight card layouts. */
export function formatMoneyCompact(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const d = cents / 100;
  const trim = (n: number) => String(Math.round(n * 10) / 10).replace(/\.0$/, "");
  if (Math.abs(d) >= 1_000_000) return `$${trim(d / 1_000_000)}M`;
  if (Math.abs(d) >= 1_000) return `$${trim(d / 1_000)}k`;
  return `$${Math.round(d)}`;
}
