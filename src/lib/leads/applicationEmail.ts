import { greetingName } from "../mca/templates";

/**
 * The note that carries a merchant's application link. Plain text, no signature (the Email dialog adds the rep's own
 * at the end). Browser-safe: the merchant page builds it as the dialog opens.
 */
export function applicationEmail(a: { contactName: string; businessName: string; link: string }): {
  subject: string;
  body: string;
} {
  const name = greetingName(a.contactName);
  return {
    subject: `Your application — ${a.businessName}`,
    body: [
      name ? `Hi ${name},` : "Hi,",
      "",
      `Here is the application for ${a.businessName}. It takes a few minutes, and you can fill it in and sign it right on your phone — no account needed:`,
      "",
      a.link,
      "",
      "As soon as it is signed I get it, and we can move on to the next step.",
    ].join("\n"),
  };
}
