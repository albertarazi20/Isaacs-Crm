import type { Metadata, Viewport } from "next";
import Image from "next/image";
import { Source_Serif_4 } from "next/font/google";
import { MerchantNotice, MerchantShell } from "@/components/upload/MerchantShell";
import { OfferView } from "@/components/offers/OfferView";
import { getSession } from "@/lib/auth/server";
import { requestTimeMs } from "@/lib/server-time";
import { openOffer } from "@/lib/system/offers";
import { merchantMetadata } from "@/lib/title";

export const dynamic = "force-dynamic";

export const viewport: Viewport = { themeColor: "#f4f2ec", colorScheme: "light" };

export const metadata: Metadata = {
  ...merchantMetadata("Your funding offer"),
  robots: { index: false, follow: false },
};

/** A text face for figures and headings: an offer should read like a term sheet, not an app screen. */
const serif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-offer-serif",
  display: "swap",
  weight: ["400", "500", "600"],
});

/**
 * The merchant's offer page. No sign-in: the token is the key. It is always on paper (light), whatever theme the
 * phone or the CRM is in. A signed-in rep looking at it (the preview) is not counted as the merchant opening it.
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
    <div
      className={`${serif.variable} offer-paper min-h-dvh bg-[#f4f2ec] text-[#0e1424]`}
      style={{ colorScheme: "light" }}
    >
      <div aria-hidden className="h-1 bg-linear-to-br from-[#4f46e5] via-[#6d28d9] to-[#c026d3]" />
      <header className="border-b border-[#e5e2d9] bg-[#f4f2ec]/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-2xl items-center justify-between gap-4 px-5">
          <Image
            src="/brand/SC-horizontal-light-web.png"
            alt={offer.shopName}
            width={800}
            height={129}
            priority
            className="h-[22px] w-auto"
          />
          <div className="text-right">
            <p className="text-[10px] font-semibold tracking-[0.24em] text-[#5f6370] uppercase">
              Private funding offer
            </p>
            <p className="text-[12px] text-[#3d4150] tabular-nums">No. {offer.number}</p>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl px-5 pt-8 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:pt-12">
        <OfferView
          offer={offer}
          token={token}
          preview={Boolean(session)}
          serverNow={requestTimeMs()}
        />
      </main>
    </div>
  );
}
