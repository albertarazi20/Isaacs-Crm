import Image from "next/image";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/server";
import { devLoginEnabled, googleConfigured, passcodeConfigured } from "@/lib/env";
import { buttonClass } from "@/components/ui";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  not_allowed: "That Google account isn't allowed in. Use your selectivecap.com account.",
  access_denied: "Google sign-in was cancelled.",
  google_error: "Google sign-in failed. Try again.",
  bad_state: "That sign-in link expired. Try again.",
  google_not_configured:
    "Google sign-in isn't set up yet (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).",
  bad_passcode: "That passcode is wrong.",
  session_expired: "Your session ended. Sign in again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  if (!error && (await getSession())) redirect("/");
  return (
    <main className="grid min-h-dvh place-items-center bg-[radial-gradient(70%_45%_at_50%_0%,color-mix(in_srgb,var(--accent)_12%,transparent),transparent)] px-6">
      <div className="w-full max-w-sm space-y-6 rounded-2xl border border-border bg-surface p-7 shadow-pop">
        <div>
          <Image
            src="/brand/SC-logomark-light-web.png"
            alt=""
            width={40}
            height={46}
            priority
            className="only-light mb-5"
          />
          <Image
            src="/brand/SC-logomark-dark-web.png"
            alt=""
            width={40}
            height={46}
            priority
            className="only-dark mb-5"
          />
          <h1 className="text-xl font-semibold tracking-tight">Selective CRM</h1>
          <p className="mt-1 text-sm text-muted">
            Leads and follow-up, one place for the whole shop.
          </p>
        </div>
        {error ? (
          <p role="alert" className="rounded-lg bg-bad-soft p-3 text-sm text-bad">
            {Object.hasOwn(MESSAGES, error) ? MESSAGES[error] : "Couldn't sign you in."}
          </p>
        ) : null}
        {googleConfigured() ? (
          <a className={buttonClass("primary", "md", "w-full")} href="/api/auth/google">
            Continue with Google
          </a>
        ) : null}
        {passcodeConfigured() ? (
          <form method="post" action="/api/auth/passcode" className="flex flex-col gap-3">
            <input
              type="password"
              name="passcode"
              required
              autoComplete="current-password"
              placeholder="Passcode"
              aria-label="Passcode"
              className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text focus:border-accent focus:ring-2 focus:ring-ring focus:outline-none"
            />
            <button type="submit" className={buttonClass("primary", "md", "w-full")}>
              Sign in
            </button>
          </form>
        ) : null}
        {devLoginEnabled() ? (
          <a className={buttonClass("secondary", "md", "w-full")} href="/api/dev-login">
            Dev login (local only)
          </a>
        ) : null}
        <p className="text-center text-[11px] text-muted">Selective Capital · internal</p>
      </div>
    </main>
  );
}
