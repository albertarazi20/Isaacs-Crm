import type { StageKey } from "./stages";

export interface TemplateArgs {
  contactName: string;
  businessName: string;
  stage: StageKey;
  senderName: string;
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? "";
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
    `${hi}it's ${me}. Just checking in — how's everything going with ${biz}, and are the payments clearing fine on your end?`,
  renewal: (hi, biz, me) =>
    `${hi}it's ${me}. You're in great shape on your current advance for ${biz}. If you want more working capital, I can likely get you a renewal on better terms — want me to take a look?`,
  default: (hi, biz, me) =>
    `${hi}it's ${me}. I'd like to help get ${biz}'s account back on track. Can we talk today about a plan that works for you?`,
  revive: (hi, biz, me) =>
    `${hi}it's ${me}. It's been a while — a lot can change. Is ${biz} looking at any funding right now? Glad to run fresh numbers.`,
};

/** A starting message. Isaac edits it; the point is never starting from a blank box. */
export function textTemplate(a: TemplateArgs): string {
  const name = firstName(a.contactName);
  return LINES[TONE[a.stage]](
    name ? `Hey ${name}, ` : "Hey, ",
    a.businessName,
    a.senderName || "Isaac",
  );
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

export function emailBody(a: TemplateArgs): string {
  const name = firstName(a.contactName);
  const line = LINES[TONE[a.stage]](
    name ? `Hi ${name},\n\n` : "Hi,\n\n",
    a.businessName,
    a.senderName || "Isaac",
  );
  return `${line}\n\nThanks,\n${a.senderName || "Isaac"}`;
}
