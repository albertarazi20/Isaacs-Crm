/**
 * The address a public request really came from, for the audit trail on signatures and acceptances.
 * Netlify's own header is the connection's address; x-forwarded-for can be written by the client, so its first entry is
 * not evidence. When only that header is there, the last entry is the one the nearest proxy appended.
 */
export function clientIp(headers: Headers): string {
  const platform = headers.get("x-nf-client-connection-ip")?.trim();
  if (platform) return platform;
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops[hops.length - 1] ?? "";
}
