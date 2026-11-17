/**
 * The email a duplicate check may match on. Lead sources fill the field with placeholders ("none@none.com",
 * "noemail@gmail.com", "test@test.com"); matching on those would make unrelated merchants "the same merchant", so a
 * placeholder matches nothing. Browser-safe and pure.
 */

const PLACEHOLDER_LOCAL = new Set([
  "none",
  "noemail",
  "no-email",
  "no_email",
  "nomail",
  "no",
  "na",
  "n/a",
  "null",
  "nil",
  "test",
  "email",
  "unknown",
  "noreply",
  "no-reply",
  "donotreply",
  "x",
  "xx",
  "xxx",
  "abc",
  "asdf",
  "fake",
  "dummy",
]);
const PLACEHOLDER_DOMAIN = new Set([
  "none.com",
  "noemail.com",
  "nomail.com",
  "test.com",
  "email.com",
  "example.com",
  "example.org",
  "example.net",
  "fake.com",
  "na.com",
]);

/** Lower-cased and trimmed, or "" when there is nothing real to match on. */
export function matchableEmail(raw: string | null | undefined): string {
  const email = (raw ?? "").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (PLACEHOLDER_LOCAL.has(local) || PLACEHOLDER_DOMAIN.has(domain)) return "";
  return email;
}
