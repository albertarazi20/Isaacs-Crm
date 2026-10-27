import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/server";
import { devLoginEnabled, googleConfigured, passcodeConfigured } from "@/lib/env";
import { buttonClass } from "@/components/ui";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  not_allowed: "That Google account isn't allowed in. Use the account Isaac was set up with.",
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
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-5 px-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Isaac</h1>
        <p className="mt-1 text-sm text-muted">
          Follow-ups, funded deals and renewals — one place.
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
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
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
    </main>
  );
}
