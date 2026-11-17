import { stageDef, type StageKey } from "./stages";

export interface TemplateArgs {
  contactName: string;
  businessName: string;
  stage: StageKey;
  senderName: string;
}

const HONORIFIC = /^(dr|mr|mrs|ms|miss|mx|prof)\.?$/i;

/** What to call the merchant: "Mike", or "Dr. Weiss" — never just "Dr.". */
export function greetingName(full: string): string {
  const [first = "", ...rest] = full.trim().split(/\s+/);
  if (HONORIFIC.test(first) && rest.length > 0) return `${first} ${rest[rest.length - 1]}`;
  return first;
}

export function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? "";
}

/** "isaac" → "Isaac". Names typed in all lowercase (an email prefix, a fast typist) shouldn't go out that way. */
export function tidy(name: string): string {
  return name === name.toLowerCase()
    ? name.replace(/(^|\s)(\p{L})/gu, (_, sp: string, c: string) => sp + c.toUpperCase())
    : name;
}

type Tone = "warm" | "app" | "stips" | "revive";

/** Which wording a merchant gets, by where they are: following up, application in, or trashed. */
function toneOf(stage: StageKey): Tone {
  if (stage === "application_sent") return "app";
  const group = stageDef(stage).group;
  return group === "prospecting" ? "warm" : group === "application" ? "stips" : "revive";
}

const LINES: Record<Tone, (hi: string, biz: string, me: string) => string> = {
  warm: (hi, biz, me) =>
    `${hi}it's ${me}. Checking in on the funding you were looking at for ${biz} — still need it? Happy to get numbers back to you quickly.`,
  app: (hi, biz, me) =>
    `${hi}it's ${me}. Circling back on the application for ${biz} — it only takes a few minutes and I can take it from there as soon as it's in.`,
  stips: (hi, biz, me) =>
    `${hi}it's ${me}. To keep ${biz} moving I still need a few documents from you — send them over when you can and I'll push it through.`,
  revive: (hi, biz, me) =>
    `${hi}it's ${me}. It's been a while — a lot can change. Is ${biz} looking at any funding right now? Glad to run fresh numbers.`,
};

/** A starting message. Isaac edits it; the point is never starting from a blank box. */
export function textTemplate(a: TemplateArgs): string {
  const name = greetingName(a.contactName);
  const me = tidy(firstName(a.senderName)) || "Selective Capital";
  return LINES[toneOf(a.stage)](name ? `Hey ${name}, ` : "Hey, ", a.businessName, me);
}

export function emailSubject(a: TemplateArgs): string {
  const subjects: Record<Tone, string> = {
    warm: `Checking in — funding for ${a.businessName}`,
    app: `Your application for ${a.businessName}`,
    stips: `Documents needed for ${a.businessName}`,
    revive: `Still looking for funding?`,
  };
  return subjects[toneOf(a.stage)];
}

export function emailBody(a: TemplateArgs, opts: { signOff?: boolean } = {}): string {
  const name = greetingName(a.contactName);
  const me = tidy(firstName(a.senderName)) || "Selective Capital";
  const line = LINES[toneOf(a.stage)](name ? `Hi ${name},\n\n` : "Hi,\n\n", a.businessName, me);
  // The email dialog adds the signature itself, so it asks for the body without the "Thanks, Name" ending.
  if (opts.signOff === false) return line;
  return `${line}\n\nThanks,\n${tidy(a.senderName.trim()) || "Isaac"}`;
}
