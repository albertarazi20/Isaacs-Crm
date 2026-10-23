"use client";

import { useEffect } from "react";

/** "(12) Isaac" in the browser tab, so a follow-up due is visible even from another tab. */
export function TitleBadge({ count }: { count: number }) {
  useEffect(() => {
    const base = "Isaac — follow-up CRM";
    document.title = count > 0 ? `(${count}) ${base}` : base;
  }, [count]);
  return null;
}
