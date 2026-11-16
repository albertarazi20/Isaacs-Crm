/**
 * Is this reply the merchant telling us to stop? Short, and says so. Quoted text (our own footer says "To stop these
 * emails") is stripped first so our words never count as theirs.
 */
const STOP =
  /\b(stop|unsubscribe|remove me|take me off|opt[- ]?out|no more emails|do not email|don'?t email|leave me alone|not interested)\b/i;

/** The merchant's own words: everything above the quoted reply and without ">" lines. */
export function ownWords(text: string): string {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\s*>/.test(line)) continue;
    if (/^On .{5,120} wrote:\s*$/.test(line)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line)) break;
    if (/^From: .+$/.test(line) && lines.length > 0) break;
    if (/^(—|--)\s*$/.test(line)) break;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

export function isStopMessage(subject: string, text: string): boolean {
  const own = ownWords(text);
  const body = own.replace(/\s+/g, " ");
  // a long message that mentions "stop" in passing is a conversation, not an opt-out
  if (body.length > 300) return false;
  return STOP.test(body) || (own.length === 0 && STOP.test(subject));
}
