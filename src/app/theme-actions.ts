"use server";

import { cookies } from "next/headers";
import { parseTheme, THEME_COOKIE, type Theme } from "@/lib/theme";

const ONE_YEAR = 60 * 60 * 24 * 365;

/** Remembers the colour mode in a cookie, so the server renders the right one and nothing flashes. */
export async function setThemeAction(theme: Theme): Promise<void> {
  const store = await cookies();
  store.set(THEME_COOKIE, parseTheme(theme), {
    path: "/",
    maxAge: ONE_YEAR,
    sameSite: "lax",
    httpOnly: false,
  });
}
