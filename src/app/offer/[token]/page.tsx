import type { Metadata } from "next";
import { MerchantNotice, MerchantShell } from "@/components/upload/MerchantShell";
import { OfferView } from "@/components/offers/OfferView";
import { getSession } from "@/lib/auth/server";
import { requestTimeMs } from "@/lib/server-time";
import { openOffer } from "@/lib/system/offers";
import { merchantMetadata } from "@/lib/title";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  ...merchantMetadata("Your funding offer"),
  robots: { index: false, follow: false },
};

/**
 * The merchant's offer page. No sign-in: the token is the key. A signed-in rep looking at it (the preview) is not
 * counted as the merchant opening it.
 */
export default async function OfferPageRoute({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await getSession().catch(() => null);
  const offer = await openOffer(token);
  if (!offer) {
    return (
      <MerchantShell label="Your offer">
        <MerchantNotice icon="link" tone="warn" title="This link isn't valid">
          Ask your contact to send the offer again. It takes them one click.
        </MerchantNotice>
      </MerchantShell>
    );
  }
  return (
    <MerchantShell label="Your offer" wide>
      <OfferView
        offer={offer}
        token={token}
        preview={Boolean(session)}
        serverNow={requestTimeMs()}
      />
    </MerchantShell>
  );
}
