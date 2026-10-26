/**
 * The six snippets everyone starts with. They live in code, not in the database: Isaac sees them until he
 * saves a snippet of his own, and "Customize" copies one into his list. Email versions may start with a
 * "Subject:" line, which fills the subject box. None of them end with a sign-off — the signature does that.
 */

export type SnippetKind = "text" | "email";

export interface SnippetView {
  /** A uuid for a saved snippet, "default:<key>" for one that lives in code. */
  id: string;
  title: string;
  kind: SnippetKind;
  body: string;
  isDefault: boolean;
}

interface DefaultSnippet {
  key: string;
  title: string;
  text: string;
  email: string;
}

const DEFAULTS: readonly DefaultSnippet[] = [
  {
    key: "send_application",
    title: "Send application",
    text: "Hey {first_name}, it's {sender}. Here's the application for {business}: {application_link} It takes about 5 minutes. As soon as it's in I'll start getting offers back from funders.",
    email:
      "Subject: Your application for {business}\n\nHi {first_name},\n\nThanks for your time. Here is the application for {business}:\n\n{application_link}\n\nIt takes about five minutes. As soon as it's signed and back to me I'll start getting offers from funders.\n\nIf you hit any snags, just reply and I'll help.",
  },
  {
    key: "need_statements",
    title: "Need statements",
    text: "Hey {first_name}, it's {sender}. To keep {business} moving I still need your last 3 months of business bank statements (all pages, PDF is fine). Can you send them over today?",
    email:
      "Subject: Bank statements needed for {business}\n\nHi {first_name},\n\nTo get {business} in front of funders I still need the last three months of business bank statements, every page. PDF is fine, and you can reply to this email with them attached.\n\nThe sooner I have them, the sooner offers come back.",
  },
  {
    key: "following_up_on_offers",
    title: "Following up on offers",
    text: "Hey {first_name}, it's {sender}. Checking in on the offers I sent for {business} — any questions, or want to hop on a quick call and go over them?",
    email:
      "Subject: Your offers for {business}\n\nHi {first_name},\n\nI wanted to follow up on the offers I sent over for {business}. Do you have a few minutes this week to go through them? I can walk you through the amounts, factor rates and remittances side by side.\n\nIf something doesn't look right, tell me what you'd want to see and I'll go back to the funders.",
  },
  {
    key: "contract_reminder",
    title: "Contract reminder",
    text: "Hey {first_name}, it's {sender}. Quick reminder to sign the contract for {business} so we can get your funding moving. Call me if you have any questions.",
    email:
      "Subject: Contract ready to sign for {business}\n\nHi {first_name},\n\nA quick reminder that the contract for {business} is waiting for your signature. Once it's signed the funder can move to fund.\n\nIf you have any questions about the terms, like the factor rate, the remittance or the payback, call me and I'll go through them with you.",
  },
  {
    key: "renewal_check",
    title: "Renewal check",
    text: "Hey {first_name}, it's {sender}. You should be well along on your current advance for {business}. Want me to see what a renewal could look like?",
    email:
      "Subject: A renewal for {business}?\n\nHi {first_name},\n\nYou're making good progress on your current advance for {business}, so you may qualify for a renewal with more working capital. Want me to run the numbers? It only takes me a few minutes to check.",
  },
  {
    key: "win_back",
    title: "Win-back",
    text: "Hey {first_name}, it's {sender}. It's been a while — is {business} looking at any funding right now? Glad to run fresh numbers.",
    email:
      "Subject: Still looking for funding?\n\nHi {first_name},\n\nIt's been a while since we spoke about {business}. A lot can change, so I wanted to check in: is funding something you're thinking about right now? I'm happy to run fresh numbers whenever it's useful.",
  },
];

export const DEFAULT_SNIPPET_TITLES: readonly string[] = DEFAULTS.map((d) => d.title);

export function defaultSnippets(kind: SnippetKind): SnippetView[] {
  return DEFAULTS.map((d) => ({
    id: `default:${d.key}`,
    title: d.title,
    kind,
    body: d[kind],
    isDefault: true,
  }));
}

/** His own snippets of this kind; the six defaults until he has saved at least one. */
export function snippetsFor(
  saved: readonly { id: string; title: string; kind: SnippetKind; body: string }[],
  kind: SnippetKind,
): SnippetView[] {
  const own = saved
    .filter((s) => s.kind === kind)
    .map((s): SnippetView => ({ ...s, isDefault: false }));
  return own.length > 0 ? own : defaultSnippets(kind);
}
