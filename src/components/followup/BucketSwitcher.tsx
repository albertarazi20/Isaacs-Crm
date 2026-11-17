"use client";

import { useEffect, useRef } from "react";
import { Segmented } from "@/components/ui";

/**
 * Every bucket as one row of pills, so a phone never needs the sidebar to change bucket. The row scrolls sideways
 * inside itself; on arrival it brings the current bucket into view.
 */
export function BucketSwitcher({
  items,
  current,
}: {
  items: readonly { id: string; name: string; members: number }[];
  current: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const nav = ref.current?.querySelector("nav");
    const active = nav?.querySelector<HTMLElement>("[aria-current=page]");
    if (!nav || !active) return;
    const left = active.offsetLeft - nav.offsetLeft;
    const hidden =
      left < nav.scrollLeft || left + active.offsetWidth > nav.scrollLeft + nav.clientWidth;
    if (hidden) nav.scrollLeft = left - (nav.clientWidth - active.offsetWidth) / 2;
  }, [current]);
  return (
    <div ref={ref} className="min-w-0">
      <Segmented
        label="Buckets"
        className="[scrollbar-width:none]"
        items={[
          { href: "/follow-up", label: "All buckets", active: false },
          ...items.map((b) => ({
            href: `/follow-up?b=${b.id}`,
            label: b.name,
            active: b.id === current,
            count: b.members,
          })),
        ]}
      />
    </div>
  );
}
