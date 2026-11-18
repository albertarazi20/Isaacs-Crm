/**
 * Is this reply the merchant telling us to stop? The message has to BE the opt-out: "STOP", "unsubscribe", "please
 * stop emailing me", "remove me from your list". A sentence that merely contains the word ("Can you stop by tomorrow?",
 * "We had to stop the second truck") is a conversation, and a wrong opt-out is permanent. Quoted text (our own footer
 * says "To stop these emails") is stripped first so our words never count as theirs.
 *
 * A missed STOP is a compliance problem (CAN-SPAM, carrier rules) and a false one costs a single lead, so the rule is:
 * when the reply clearly asks us to stop, opt out. A bare keyword anywhere in a short reply counts ("You've emailed me
 * 5 times. Stop."), signatures and phone footers do not hide one, and only a reply that goes on to ask for a call
 * back reads as a conversation ("Stop, call me at 305-555-0100").
 */

/** Words that change nothing about the meaning at the edges of an opt-out ("please stop, thanks"). */
const FILLER = new Set([
  "please",
  "pls",
  "plz",
  "kindly",
  "thanks",
  "thx",
  "thank",
  "you",
  "ok",
  "okay",
  "sorry",
  "just",
  "now",
  "again",
  "immediately",
  "asap",
  "yes",
]);

/** The carrier keywords: a fragment that is only one of these is an opt-out ("end", "cancel" inside a sentence are not). */
const BARE =
  /^(?:stop|stopall|stop all|unsub|unsubscribe|unsubscribed|unsubscribing|remove|cancel|end|quit|optout|opt out|revoke)$/;

/** A bare keyword next to one of these is a conversation ("Stop, call me at ..."), not an opt-out. */
const ASKS_FOR_CALLBACK =
  /\b(?:call|ring|phone|text|reach|get back to) me\b|\b(?:call|ring|phone) (?:us|back)\b/;

/** The most words a reply may have for a bare keyword inside it to count. */
const BARE_MAX_WORDS = 25;

/** Lines that are a mail app's signature, not the merchant's words. */
const SIGNATURE =
  /\b(?:sent (?:from|via|with|using) [a-z0-9 .'@-]{1,60}|get outlook for [a-z]+)$|^[-_=~ ]{2,}$/gm;

/** Words that may trail an opt-out phrase without changing what it says ("remove me from your mailing list"). */
const T =
  "(?: (?:me|us|my|your|our|the|this|that|these|those|any|all|more|further|anymore|any more|from|off|of|list|lists|mailing|email|emails|e|mail|message|messages|text|texts|call|calls|number|numbers|address|info|information|database|records|contact|spam|in|at|about|it|ever|forever|again|now|immediately|asap|please|thanks|else|newsletter|newsletters))*";
/** What may follow "stop emailing me": a threat or a reason ("or I will report you"). */
const THREAT = "(?: (?:or|otherwise|else|because|and i will|i will|i'll|we will|we'll) .*)?";
const NOUN = "(?:emails?|e mails?|messages?|mail|texts?|calls?|spam|contact)";
/** Phrases that mean "no more" wherever they stand in the message (each is a sentence of its own). */
const STRONG = [
  new RegExp(
    `^stop (?:emailing|e mailing|texting|calling|contacting|messaging|mailing|sending|bothering)${T}${THREAT}$`,
  ),
  new RegExp(`^stop (?:(?:all|these|those|the|your|any|more|further|this|my) )*${NOUN}${T}$`),
  new RegExp(`^(?:unsubscribe|unsub|unsubscribed|unsubscribing)${T}$`),
  new RegExp(`^(?:remove|delete|take) (?:me|us|my [a-z]+)${T}$`),
  /^opt(?: |)out(?: of [a-z ]{0,40})?$/,
  new RegExp(`^opt (?:me|us) out${T}$`),
  new RegExp(`^no more ${NOUN}${T}$`),
  new RegExp(`\\b(?:do not|don't|dont|never) (?:email|e mail|contact|call|text|message|mail)${T}$`),
  new RegExp(
    `\\b(?:do not|don't|dont|never) send (?:me|us) (?:anything|any|more|another|further|nothing|emails?|e mails?|messages?|mail|texts?)${T}$`,
  ),
  new RegExp(`\\bleave (?:me|us) (?:alone|be)${T}$`),
  /\bcease (?:and desist|contact|communication|emailing|contacting)\b/,
  new RegExp(`\\b(?:want|like|wish|need) to (?:unsubscribe|be removed|be taken off|opt out)${T}$`),
  new RegExp(
    `\\b(?:told|tell|asked|ask|telling|asking) (?:you|u|them|your team)(?: [a-z']+){0,4} to stop(?: (?:emailing|e mailing|texting|calling|contacting|messaging|mailing|sending|bothering)${T})?$`,
  ),
  /\bno longer interested(?: (?:thanks|in this|at all|in any))*$/,
  /\bnot interested(?: (?:thanks|anymore|any more|in this|at all|in any))*$/,
];

/** What a fragment says once the polite edges are trimmed; null if it was only a greeting or politeness. */
function core(fragment: string): string | null {
  const words = fragment.split(" ").filter(Boolean);
  // "hi John" / "dear Mike" / "good morning" on its own is a greeting; "hi stop" is a greeting then a request
  if (
    /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))(?: (?!(?:stop|unsubscribe|cancel|quit|end)$)[a-z']+)?$/.test(
      fragment,
    )
  )
    return null;
  if (/^(?:hi|hello|hey)$/.test(words[0] ?? "")) words.shift();
  while (words.length > 0 && FILLER.has(words[0] ?? "")) words.shift();
  while (words.length > 0 && FILLER.has(words[words.length - 1] ?? "")) words.pop();
  return words.length > 0 ? words.join(" ") : null;
}

/** True when the whole text (its fragments, ignoring greetings, thanks and signatures) is an opt-out. */
export function isOptOutText(text: string): boolean {
  const lower = text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(SIGNATURE, "");
  const fragments = lower
    .split(/[.!?;,\n]+/)
    .map((f) =>
      f
        .replace(/[^a-z0-9' ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .map(core)
    .filter((f): f is string => f !== null);
  if (fragments.length === 0) return false;
  if (fragments.some((f) => STRONG.some((re) => re.test(f)))) return true;
  // a bare keyword in a short reply ("Stop." after a complaint, "Stop" over a signature name) is the opt-out
  const words = fragments.join(" ").split(" ").length;
  return (
    words <= BARE_MAX_WORDS &&
    fragments.some((f) => BARE.test(f)) &&
    !fragments.some((f) => ASKS_FOR_CALLBACK.test(f))
  );
}

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
  // a one-line copy (a mail snippet) keeps its quote inline: cut it where the quote starts
  const body = own
    .replace(/\s+(?:On .{5,120}? wrote:|-{2,} ?Original Message|From: )[\s\S]*$/i, "")
    .trim();
  // a long message that mentions "stop" in passing is a conversation, not an opt-out
  if (body.replace(/\s+/g, " ").length > 300) return false;
  // the lines stay apart: a signature below the keyword is told from the keyword by its own line
  if (body.length > 0) return isOptOutText(body);
  return isOptOutText(subject.replace(/^\s*(?:(?:re|fw|fwd)\s*:\s*)+/i, ""));
}
