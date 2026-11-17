import { redirect } from "next/navigation";
import { Glyph } from "@/components/shell/icons";
import { BrandLogo } from "@/components/upload/MerchantShell";
import { buttonClass } from "@/components/ui";
import { getSession } from "@/lib/auth/server";
import { devLoginEnabled, googleConfigured, passcodeConfigured } from "@/lib/env";

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

/** What is waiting on the other side of the door, in three plain lines. */
const INSIDE = [
  { icon: "followup", label: "Follow-up that runs itself" },
  { icon: "file", label: "Applications and documents in" },
  { icon: "bell", label: "Alerts the moment they sign" },
] as const;

/** Google's "G", drawn in the button's own ink. */
function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-[18px]" fill="currentColor">
      <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
    </svg>
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  if (!error && (await getSession())) redirect("/");
  const google = googleConfigured();
  const passcode = passcodeConfigured();
  const dev = devLoginEnabled();
  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-5 py-10">
      {/* the brand's own light, gathered behind the card */}
      <div
        aria-hidden
        className="bg-brand pointer-events-none absolute top-1/2 left-1/2 size-[560px] -translate-x-1/2 -translate-y-[58%] rounded-full opacity-20 blur-[110px]"
      />
      <div className="relative w-full max-w-[440px] animate-rise">
        <div className="ring-brand glass-strong rounded-[28px] border border-border p-7 shadow-pop sm:p-10">
          <BrandLogo className="h-7" />
          <p className="eyebrow mt-9">Selective CRM</p>
          <h1 className="mt-2 text-[34px] leading-[1.04] font-semibold tracking-[-0.04em] text-balance sm:text-[40px]">
            Every interested merchant, <span className="text-gradient">followed up.</span>
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-text-2">
            Leads and follow-up, one place for the whole shop.
          </p>

          {error ? (
            <p
              role="alert"
              className="mt-6 flex items-start gap-2.5 rounded-2xl border border-bad/30 bg-bad-soft px-4 py-3 text-sm text-bad"
            >
              <Glyph name="alert" className="mt-0.5 size-4 shrink-0" />
              <span>
                {Object.hasOwn(MESSAGES, error) ? MESSAGES[error] : "Couldn't sign you in."}
              </span>
            </p>
          ) : null}

          <div className="mt-7 space-y-3">
            {google ? (
              <a
                className={buttonClass("primary", "lg", "h-13 w-full gap-2.5 text-base")}
                href="/api/auth/google"
              >
                <GoogleMark />
                Continue with Google
              </a>
            ) : null}
            {google && passcode ? (
              <div className="flex items-center gap-3 py-1" aria-hidden>
                <span className="h-px flex-1 bg-border" />
                <span className="eyebrow">or</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            ) : null}
            {passcode ? (
              <form method="post" action="/api/auth/passcode" className="flex flex-col gap-3">
                <input
                  type="password"
                  name="passcode"
                  required
                  autoComplete="current-password"
                  placeholder="Passcode"
                  aria-label="Passcode"
                  className="h-13 w-full rounded-full border border-border bg-surface-3 px-5 text-base text-text shadow-[inset_0_1px_2px_var(--shadow-c1)] transition duration-150 placeholder:text-muted hover:border-border-strong focus:border-accent focus:bg-surface focus:ring-[3px] focus:ring-ring focus:outline-none"
                />
                <button
                  type="submit"
                  className={buttonClass(
                    google ? "secondary" : "primary",
                    "lg",
                    "h-13 w-full text-base",
                  )}
                >
                  Sign in
                  <Glyph name="arrowRight" className="size-4" strokeWidth={2.2} />
                </button>
              </form>
            ) : null}
            {dev ? (
              <a
                className={buttonClass(
                  google || passcode ? "ghost" : "primary",
                  "lg",
                  "h-13 w-full text-base",
                )}
                href="/api/dev-login"
              >
                Dev login (local only)
              </a>
            ) : null}
          </div>

          <ul className="mt-8 space-y-2.5 border-t border-border pt-6">
            {INSIDE.map((it) => (
              <li key={it.label} className="flex items-center gap-3 text-[13px] text-text-2">
                <span
                  aria-hidden
                  className="bg-brand-soft flex size-7 shrink-0 items-center justify-center rounded-full text-accent ring-1 ring-accent/20"
                >
                  <Glyph name={it.icon} className="size-3.5" />
                </span>
                {it.label}
              </li>
            ))}
          </ul>
        </div>
        <p className="mt-6 text-center text-[11px] tracking-wide text-muted">
          Selective Capital · internal
        </p>
      </div>
    </main>
  );
}
