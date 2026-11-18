import { isIP } from "node:net";

/**
 * The address a public request really came from. Two forms of the same trusted reading:
 *  - `clientIp` is what every limiter, lock and guard keys on (rate limits, the passcode lock, the failed-sign-in
 *    guard, new-device checks). An IPv6 address is cut to its /64, because one home or office network is handed the
 *    whole /64 and could otherwise mint billions of "different" addresses and a fresh bucket for each.
 *  - `exactClientIp` is the full address, for the record of who signed or accepted something.
 *
 * Trust: Netlify's own header (x-nf-client-connection-ip) is the connection's address. x-forwarded-for can be written
 * by the client, so in production it is never used: with no platform header the answer is "" and callers fall back to
 * their shared bucket. Outside production (development, tests, a local proxy) the last x-forwarded-for entry, the one
 * the nearest proxy appended, is used when the platform header is absent. Anything that is not an IP address reads
 * as "".
 */

/** Takes the brackets, port and zone off an address as proxies write it: "[2001:db8::1]:443", "1.2.3.4:80", "fe80::1%en0". */
function stripDecoration(raw: string): string {
  let s = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed?.[1]) s = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  const zone = s.indexOf("%");
  return zone >= 0 ? s.slice(0, zone) : s;
}

/** Eight 16-bit groups of an IPv6 address (the dotted-quad tail counts as two), or null when it is not one. */
function groupsOf(addr: string): number[] | null {
  if (isIP(addr) !== 6) return null;
  let text = addr;
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail?.[1]) {
    const o = tail[1].split(".").map(Number);
    const hi = ((o[0] ?? 0) << 8) | (o[1] ?? 0);
    const lo = ((o[2] ?? 0) << 8) | (o[3] ?? 0);
    text = `${text.slice(0, -tail[1].length)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16));
  const head = parse(halves[0] ?? "");
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = parse(halves[1] ?? "");
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...Array<number>(fill).fill(0), ...rest];
}

/** RFC 5952 text: lower case, no leading zeros, the longest run of two or more zero groups written "::". */
function compress(groups: number[]): string {
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j;
  }
  const hex = (g: number[]) => g.map((n) => n.toString(16)).join(":");
  if (best.len < 2) return hex(groups);
  return `${hex(groups.slice(0, best.at))}::${hex(groups.slice(best.at + best.len))}`;
}

/** Reads one address. IPv4-mapped IPv6 ("::ffff:1.2.3.4") is the IPv4 address it wraps. "" when it is not an address. */
function parse(raw: string): { text: string; prefix: string } {
  const s = stripDecoration(raw);
  if (isIP(s) === 4) return { text: s, prefix: s };
  const g = groupsOf(s);
  if (!g) return { text: "", prefix: "" };
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    const v4 = `${(g[6] ?? 0) >> 8}.${(g[6] ?? 0) & 255}.${(g[7] ?? 0) >> 8}.${(g[7] ?? 0) & 255}`;
    return { text: v4, prefix: v4 };
  }
  return {
    text: compress(g),
    prefix: `${g
      .slice(0, 4)
      .map((n) => n.toString(16))
      .join(":")}::/64`,
  };
}

/** The key form: an IPv4 address as is, an IPv6 address as its /64 ("2001:db8:0:1::/64"), "" when unreadable. */
export const normalizeIp = (raw: string): string => parse(raw).prefix;

/** The full address in its plain form, "" when unreadable. */
export const canonicalIp = (raw: string): string => parse(raw).text;

/** The raw address string the headers vouch for, or "" when they vouch for none. */
function trustedAddress(headers: Headers): string {
  const platform = headers.get("x-nf-client-connection-ip")?.trim();
  if (platform) return platform;
  // the client can write x-forwarded-for: never evidence in production
  if (process.env.NODE_ENV === "production") return "";
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops[hops.length - 1] ?? "";
}

/** The address to key limits, locks and guards on (IPv6 cut to its /64). "" when there is none to trust. */
export function clientIp(headers: Headers): string {
  return normalizeIp(trustedAddress(headers));
}

/** The full address, for the record of who signed or accepted something. "" when there is none to trust. */
export function exactClientIp(headers: Headers): string {
  return canonicalIp(trustedAddress(headers));
}
