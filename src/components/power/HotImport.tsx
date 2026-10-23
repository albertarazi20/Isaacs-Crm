"use client";

import { useEffect } from "react";
import { importLocalStars } from "./prefs";

/** Renders nothing. Once per page load, moves any stars this browser kept for itself onto the server. */
export function HotImport() {
  useEffect(() => {
    void importLocalStars().catch(() => undefined);
  }, []);
  return null;
}
