import type { Metadata } from "next";

/**
 * Tab titles. A signed-in page reads "(12) Follow Up · Selective CRM": the count is what is due, so the tab
 * says it at a glance. A merchant's page never says CRM; it names the shop.
 */
export const APP_NAME = "Selective CRM";
export const SHOP_NAME = "Selective Capital";

export function appTitle(due: number, page?: string): string {
  return `${due > 0 ? `(${due}) ` : ""}${page ? `${page} · ` : ""}${APP_NAME}`;
}

/** Metadata for a page a merchant opens from a link: the shop's name, in the tab and on a saved home screen. */
export function merchantMetadata(page: string): Metadata {
  return {
    title: `${page} · ${SHOP_NAME}`,
    appleWebApp: { capable: true, title: SHOP_NAME, statusBarStyle: "black-translucent" },
  };
}
