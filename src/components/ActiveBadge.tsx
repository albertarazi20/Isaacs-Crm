import { timeAgo } from "@/lib/format";
import { Glyph } from "./shell/icons";
import { Badge } from "./ui";

/** Within this long, a merchant's own move (a reply, an open, a document, a signature) marks them as active. */
export const ACTIVE_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * "Active 3h ago": the merchant themself did something in the last two days (CardMeta.active_at). Nothing when they
 * did not: a quiet merchant is the normal case and needs no mark.
 */
export function ActiveBadge({ at, nowMs }: { at: string | null | undefined; nowMs: number }) {
  if (!at) return null;
  const t = new Date(at).getTime();
  if (!Number.isFinite(t) || nowMs - t > ACTIVE_WINDOW_MS) return null;
  return (
    <Badge tone="warn">
      <Glyph name="zap" className="size-3" />
      Active {timeAgo(at, new Date(nowMs))}
    </Badge>
  );
}
