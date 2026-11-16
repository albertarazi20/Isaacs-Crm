import type { StageKey } from "./stages";

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

type Tone = "warm" | "app" | "stips" | "offer" | "funded" | "renewal" | "default" | "revive";

const TONE: Record<StageKey, Tone> = {
  name_in: "warm",
  spoke_with_owner: "warm",
  interested: "warm",
  call_scheduled: "warm",
  application_sent: "app",
  application_in: "stips",
  stips: "stips",
  submitted: "offer",
  offers_in: "offer",
  offer_presented: "offer",
  contract_out: "offer",
  funded: "funded",
  paying_off_soon: "renewal",
  paid_in_full: "renewal",
  default_workable: "default",
  default_bad: "default",
  legal_collections: "default",
  written_off: "default",
  declined: "revive",
  lost: "revive",
  killed: "revive",
  dead: "revive",
  not_interested: "revive",
};

const LINES: Record<Tone, (hi: string, biz: string, me: string) => string> = {
  warm: (hi, biz, me) =>
    `${hi}it's ${me}. Checking in on the funding you were looking at for ${biz} — still need it? Happy to get numbers back to you quickly.`,
  app: (hi, biz, me) =>
    `${hi}it's ${me}. Circling back on the application for ${biz} — it only takes a few minutes and I can get offers moving as soon as it's in.`,
  stips: (hi, biz, me) =>
    `${hi}it's ${me}. To keep ${biz} moving I still need a few documents from you — send them over when you can and I'll push it through.`,
  offer: (hi, biz, me) =>
    `${hi}it's ${me}. Quick update on the offers for ${biz} — do you have a few minutes to go over them?`,
  funded: (hi, biz, me) =>
    `${hi}it's ${me}. Just checking in — how's everything going with ${biz}, and are the remittances clearing fine on your end?`,
  renewal: (hi, biz, me) =>
    `${hi}it's ${me}. You're in great shape on your current advance for ${biz}. If you want more working capital, I can likely get you a renewal on better terms — want me to take a look?`,
  default: (hi, biz, me) =>
    `${hi}it's ${me}. I'd like to help get ${biz}'s account back on track. Can we talk today about a plan that works for you?`,
  revive: (hi, biz, me) =>
    `${hi}it's ${me}. It's been a while — a lot can change. Is ${biz} looking at any funding right now? Glad to run fresh numbers.`,
};

/** A starting message. Isaac edits it; the point is never starting from a blank box. */
export function textTemplate(a: TemplateArgs): string {
  const name = greetingName(a.contactName);
  const me = tidy(firstName(a.senderName)) || "Selective Capital";
  return LINES[TONE[a.stage]](name ? `Hey ${name}, ` : "Hey, ", a.businessName, me);
}

export function emailSubject(a: TemplateArgs): string {
  const subjects: Record<Tone, string> = {
    warm: `Checking in — funding for ${a.businessName}`,
    app: `Your application for ${a.businessName}`,
    stips: `Documents needed for ${a.businessName}`,
    offer: `Update on your offers — ${a.businessName}`,
    funded: `Checking in on ${a.businessName}`,
    renewal: `More working capital for ${a.businessName}?`,
    default: `Your account — let's find a plan`,
    revive: `Still looking for funding?`,
  };
  return subjects[TONE[a.stage]];
}

export function emailBody(a: TemplateArgs, opts: { signOff?: boolean } = {}): string {
  const name = greetingName(a.contactName);
  const me = tidy(firstName(a.senderName)) || "Selective Capital";
  const line = LINES[TONE[a.stage]](name ? `Hi ${name},\n\n` : "Hi,\n\n", a.businessName, me);
  // The email dialog adds the signature itself, so it asks for the body without the "Thanks, Name" ending.
  if (opts.signOff === false) return line;
  return `${line}\n\nThanks,\n${tidy(a.senderName.trim()) || "Isaac"}`;
}

// ---------------------------------------------------------------------------------------------
// Win-back: a first text to a merchant who said no, went quiet, was declined or funded elsewhere.

/** What the shop knows about a lost deal's competing offer. Everything but the funder may be missing. */
export interface WinbackOffer {
  funderName: string;
  factorRate: number | null;
  termDays: number | null;
  offeredOn: string | null;
  /** True when this is the offer the merchant took ("Lost deal" logs it that way). */
  won: boolean;
}

export interface WinbackArgs {
  contactName: string;
  businessName: string;
  stage: StageKey;
  senderName: string;
  /** Their latest ask in cents, when known. */
  wantedAmountCents?: number | null;
  /** Lost deals only: what the competitor offered. */
  offer?: WinbackOffer | null;
  /** Isaac's today, "YYYY-MM-DD". */
  today: string;
}

/** 1.42, 1.4 → "1.40", 1.345. */
export function factorText(f: number): string {
  const s = f.toFixed(3);
  return s.endsWith("0") ? s.slice(0, -1) : s;
}

const dollars = (cents: number): string => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

/** How far through its term a competitor's advance should be (0 to 1+), or null when we can't tell. */
export function offerProgress(offer: WinbackOffer, today: string): number | null {
  if (!offer.offeredOn || !offer.termDays || offer.termDays <= 0) return null;
  const from = Date.parse(`${offer.offeredOn}T00:00:00Z`);
  const to = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return (to - from) / 86_400_000 / offer.termDays;
}

/**
 * A reason-aware win-back text. It only says what the system knows and hedges the rest ("may", "should"):
 * we never claim a merchant's revenue grew or that an advance is half paid when we haven't checked.
 */
export function winbackText(a: WinbackArgs): string {
  const name = greetingName(a.contactName);
  const me = tidy(firstName(a.senderName)) || "Selective Capital";
  const hi = name ? `Hey ${name}, ` : "Hey, ";
  const opener = `${hi}it's ${me}. `;
  const biz = a.businessName;

  switch (a.stage) {
    case "lost": {
      const o = a.offer;
      if (!o) {
        return `${opener}Your advance with the other funder may be about half paid by now — want me to look at a renewal elsewhere?`;
      }
      const rival = o.factorRate
        ? `${o.funderName}'s ${factorText(o.factorRate)} advance`
        : `${o.funderName}'s advance`;
      if (!o.won) {
        // A quote we logged, not a deal we know they signed.
        return `${opener}If you went with ${rival}, it may be about half paid by now — want me to look at a renewal elsewhere?`;
      }
      const progress = offerProgress(o, a.today);
      if (progress === null) {
        return `${opener}${rival} may be about half paid by now — want me to look at a renewal elsewhere?`;
      }
      if (progress >= 0.9) {
        return `${opener}${rival} should be close to paid off by now — want me to look at a renewal elsewhere?`;
      }
      if (progress >= 0.4) {
        return `${opener}${rival} should be about half paid by now — want me to look at a renewal elsewhere?`;
      }
      return `${opener}${rival} may still have a way to go, but if you'd like a second look at better terms for ${biz}, I'm glad to run fresh numbers.`;
    }
    case "declined": {
      const ask = a.wantedAmountCents ? ` your ${dollars(a.wantedAmountCents)} request` : "";
      return `${opener}Your revenue may have grown since we last looked at ${biz} — want me to resubmit${ask}?`;
    }
    case "killed":
      return `${opener}We put ${biz} on hold a while back. If funding is back on your radar, I'm glad to run fresh numbers.`;
    case "not_interested":
      return `${opener}No pressure at all — just checking in in case things have changed for ${biz}. If you ever want fresh numbers, just say the word.`;
    case "written_off":
      return `${opener}I hope business is treating you better. If you'd like to talk about where things stand, or what funding could look like going forward, I'm glad to help.`;
    default:
      return `${opener}Been a while — still looking for funding? Glad to run fresh numbers for ${biz}.`;
  }
}
