/** Finding a merchant in a bucket list. Browser-safe (no server imports). */

export interface Searchable {
  business_name: string;
  contact_name: string;
  email: string;
  phone: string;
  state: string;
  /** Only the all-buckets search has this: typing a bucket's name finds its people. */
  bucket_name?: string;
  rep_name?: string;
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

/**
 * Every word typed must be found somewhere on the merchant (name, contact, email, state, bucket, rep), so "pioneer
 * vale" finds a business and its contact together. A word that is mostly digits is matched against the phone as
 * digits, so "305-555", "(305) 555 01" and "+1305555" all find (305) 555-0100 however the number was stored.
 */
export function matchesSearch(m: Searchable, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [
    m.business_name,
    m.contact_name,
    m.email,
    m.state,
    m.bucket_name ?? "",
    m.rep_name ?? "",
  ]
    .join("\n")
    .toLowerCase();
  const phone = digitsOf(m.phone);
  return words.every((w) => {
    if (text.includes(w)) return true;
    const d = digitsOf(w);
    // a word like "305" is ambiguous (a name can hold digits): digits count as a phone search from three on
    // (phone punctuation, "1-305-555-0100", does not count against the word)
    if (d.length < 3 || d.length < w.replace(/[-().+]/g, "").length - 2) return false;
    if (phone.includes(d)) return true;
    // a country code typed in front ("+1305555", "1-305-555-0100") against a number stored without it
    return d.length > 3 && d.startsWith("1") && phone.includes(d.slice(1));
  });
}
