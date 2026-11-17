import {
  MerchantHeading,
  MerchantNotice,
  MerchantShell,
  shopLabel,
} from "@/components/upload/MerchantShell";
import { buttonClass } from "@/components/ui";
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
      <MerchantShell label="Email preferences">
        <MerchantNotice icon="link" tone="warn" title="This link isn't valid">
          Reply to the email you received and ask to be removed. We will do it by hand.
        </MerchantNotice>
      </MerchantShell>
    );
  }
  const finished = v.already || done === "1";
  if (finished) {
    return (
      <MerchantShell label="Email preferences">
        <MerchantNotice icon="check" tone="good" title="You're unsubscribed">
          {v.maskedEmail || "This address"} will not get automated emails from {v.shopName} about{" "}
          {v.businessName}. Your rep can still write to you directly.
        </MerchantNotice>
      </MerchantShell>
    );
  }
  return (
    <MerchantShell label="Email preferences">
      <MerchantHeading eyebrow={shopLabel(v.shopName)} title="Stop these emails?">
        {v.maskedEmail || "Your address"} will stop getting automated emails from {v.shopName} about{" "}
        {v.businessName}.
      </MerchantHeading>
      <form
        method="post"
        action={`/api/unsubscribe/${encodeURIComponent(token)}`}
        className="mt-7 rounded-3xl border border-border bg-surface p-5 sm:p-6"
      >
        <dl className="space-y-3 text-sm">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted">Address</dt>
            <dd className="min-w-0 truncate font-medium">{v.maskedEmail || "Your address"}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-t border-border pt-3">
            <dt className="text-muted">About</dt>
            <dd className="min-w-0 truncate font-medium">{v.businessName}</dd>
          </div>
        </dl>
        <button type="submit" className={buttonClass("primary", "lg", "mt-5 h-13 w-full")}>
          Stop these emails
        </button>
        <p className="mt-3 text-center text-xs text-muted">One tap. No sign-in needed.</p>
      </form>
    </MerchantShell>
  );
}
