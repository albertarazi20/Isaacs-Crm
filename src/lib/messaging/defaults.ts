/**
 * The two snippets everyone starts with. They live in code, not in the database: Isaac sees them until he
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
    text: "Hey {first_name}, it's {sender}. Here's the application for {business}: {application_link} It takes about 5 minutes. As soon as it's in I'll take it from there.",
    email:
      "Subject: Your application for {business}\n\nHi {first_name},\n\nThanks for your time. Here is the application for {business}:\n\n{application_link}\n\nIt takes about five minutes. As soon as it's signed and back to me I'll take it from there.\n\nIf you hit any snags, just reply and I'll help.",
  },
  {
    key: "need_statements",
    title: "Need statements",
    text: "Hey {first_name}, it's {sender}. To keep {business} moving I still need your last 3 months of business bank statements (all pages, PDF is fine). Can you send them over today?",
    email:
      "Subject: Bank statements needed for {business}\n\nHi {first_name},\n\nTo keep {business} moving I still need the last three months of business bank statements, every page. PDF is fine, and you can reply to this email with them attached.\n\nThe sooner I have them, the sooner I can take it from there.",
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

/** His own snippets of this kind; the defaults until he has saved at least one. */
export function snippetsFor(
  saved: readonly { id: string; title: string; kind: SnippetKind; body: string }[],
  kind: SnippetKind,
): SnippetView[] {
  const own = saved
    .filter((s) => s.kind === kind)
    .map((s): SnippetView => ({ ...s, isDefault: false }));
  return own.length > 0 ? own : defaultSnippets(kind);
}
