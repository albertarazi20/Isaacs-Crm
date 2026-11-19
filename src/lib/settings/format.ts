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

/** 600 → "10:00" (what a time input holds). */
export function minuteToTime(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** "10:00" → 600. An empty or broken value gives 0, which the server refuses with its plain-words message. */
export function timeToMinute(time: string): number {
  const m = /^(\d{2}):(\d{2})/.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** 600 → "10:00 AM", 1200 → "8:00 PM". */
export function minuteLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  return `${h % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
