/** "winback:approved_unfunded:2" → "Step 2 email"; no email before the money came back → a plain sentence. */
export function templateLabel(source: string | null): string {
  const step = source ? /^winback:[^:]+:(\d+)$/.exec(source)?.[1] : undefined;
  if (step) return `Step ${step} email`;
  return source ? source : "Funded before any email";
}
