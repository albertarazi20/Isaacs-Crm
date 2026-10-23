import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { env } from "@/lib/env";

export async function POST() {
  const res = NextResponse.redirect(`${env().APP_URL}/login`, 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
