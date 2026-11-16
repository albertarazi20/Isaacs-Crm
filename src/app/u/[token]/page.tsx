import Image from "next/image";
import { buttonClass } from "@/components/ui";
import { db } from "@/lib/db";
import { resolveUnsubscribe } from "@/lib/system/replies";

export const dynamic = "force-dynamic";

/** The S logomark, the right one for the mode. */
function Logomark() {
  return (
    <>
      <Image
        src="/brand/SC-logomark-light-web.png"
        alt="Selective Capital"
        width={36}
        height={42}
        priority
        className="only-light h-10 w-auto"
      />
      <Image
        src="/brand/SC-logomark-dark-web.png"
        alt="Selective Capital"
        width={36}
        height={42}
        priority
        className="only-dark h-10 w-auto"
      />
    </>
  );
}

/** The footer link. One button, no sign-in, no other merchant's data. */
export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { token } = await params;
  const { done } = await searchParams;
  const v = await resolveUnsubscribe(db, token);
  if (!v) {
    return (
      <main className="mx-auto max-w-md px-5 py-14 sm:py-20">
        <Logomark />
        <h1 className="mt-6 text-xl font-semibold tracking-tight">This link isn&apos;t valid</h1>
        <p className="mt-2 text-sm text-muted">
          Reply to the email you received and ask to be removed — we will do it by hand.
        </p>
      </main>
    );
  }
  const finished = v.already || done === "1";
  return (
    <main className="mx-auto max-w-md px-5 py-14 sm:py-20">
      <div className="flex items-center gap-3">
        <Logomark />
        <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{v.shopName}</p>
      </div>
      {finished ? (
        <>
          <h1 className="mt-6 text-2xl font-semibold tracking-tight sm:text-3xl">
            You&apos;re unsubscribed
          </h1>
          <p className="mt-2 text-sm text-text-2">
            {v.maskedEmail || "This address"} will not get automated emails from {v.shopName} about{" "}
            {v.businessName}. Your rep can still write to you directly.
          </p>
        </>
      ) : (
        <>
          <h1 className="mt-6 text-2xl font-semibold tracking-tight sm:text-3xl">
            Stop these emails?
          </h1>
          <p className="mt-2 text-sm text-text-2">
            {v.maskedEmail || "Your address"} will stop getting automated emails from {v.shopName}{" "}
            about {v.businessName}.
          </p>
          <form
            method="post"
            action={`/api/unsubscribe/${encodeURIComponent(token)}`}
            className="mt-6"
          >
            <button
              type="submit"
              className={buttonClass(
                "primary",
                "md",
                "h-12 w-full text-base sm:h-11 sm:w-auto sm:px-6",
              )}
            >
              Stop these emails
            </button>
          </form>
        </>
      )}
    </main>
  );
}
