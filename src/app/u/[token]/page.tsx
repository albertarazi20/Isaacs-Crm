import { db } from "@/lib/db";
import { resolveUnsubscribe } from "@/lib/system/replies";

export const dynamic = "force-dynamic";

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
      <main className="mx-auto max-w-md px-5 py-16">
        <h1 className="text-xl font-semibold">This link isn&apos;t valid</h1>
        <p className="mt-2 text-muted">
          Reply to the email you received and ask to be removed — we will do it by hand.
        </p>
      </main>
    );
  }
  const finished = v.already || done === "1";
  return (
    <main className="mx-auto max-w-md px-5 py-16">
      <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{v.shopName}</p>
      {finished ? (
        <>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">You&apos;re unsubscribed</h1>
          <p className="mt-2 text-muted">
            {v.maskedEmail || "This address"} will not get automated emails from {v.shopName} about{" "}
            {v.businessName}. Your rep can still write to you directly.
          </p>
        </>
      ) : (
        <>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Stop these emails?</h1>
          <p className="mt-2 text-muted">
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
              className="rounded-lg bg-text px-4 py-2 text-sm font-semibold text-surface"
            >
              Stop these emails
            </button>
          </form>
        </>
      )}
    </main>
  );
}
