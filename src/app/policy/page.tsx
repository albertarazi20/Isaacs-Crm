import Image from "next/image";
import { redirect } from "next/navigation";
import { PolicyAccept } from "@/components/PolicyAccept";
import { requireSession } from "@/lib/auth/server";
import { loadShell } from "@/lib/data/shell";

export const dynamic = "force-dynamic";

/**
 * The first-login gate (plan §14.7): confidentiality and non-solicitation, with the plain notice that copies and
 * exports are logged. Nothing else in the app opens until it is accepted once.
 */
export default async function PolicyPage() {
  const session = await requireSession();
  const me = await loadShell(session.userId);
  if (me.user?.policy_accepted_at) redirect("/");
  const shop = "Selective Capital";
  return (
    <main className="mx-auto max-w-xl px-5 py-12">
      <Image
        src="/brand/SC-logomark-light-web.png"
        alt=""
        width={36}
        height={42}
        priority
        className="only-light mb-5"
      />
      <Image
        src="/brand/SC-logomark-dark-web.png"
        alt=""
        width={36}
        height={42}
        priority
        className="only-dark mb-5"
      />
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Before you start</h1>
      <p className="mt-2 text-sm text-muted">
        One page, once. It says how the merchants in this CRM may be used, and what the system
        records.
      </p>
      <section className="mt-6 space-y-4 rounded-xl border border-border bg-surface p-5 text-sm leading-6">
        <h2 className="text-[13px] font-semibold">Confidentiality</h2>
        <p>
          Every merchant, contact detail, statement and offer in this CRM belongs to {shop}. They
          are confidential and are used only to work the shop&apos;s deals. They are not to be
          copied out, photographed, forwarded, or shared with anyone outside the shop, during or
          after your time here.
        </p>
        <h2 className="text-[13px] font-semibold">Non-solicitation</h2>
        <p>
          Merchants and lenders you meet through this CRM are the shop&apos;s relationships. You
          agree not to divert a deal, submit a merchant to a lender outside the shop, or solicit
          these merchants for anyone else, while you are here and for twelve months after.
        </p>
        <h2 className="text-[13px] font-semibold">What the system records</h2>
        <p>
          Every view and copy of a phone number or email, every document opened, every export, and
          every contact-detail change is logged with who and when. Some merchants are canaries: a
          call to one tells the shop exactly whose book leaked. Documents carry your name as a
          watermark. Leaving the shop closes your login at once and moves your merchants to someone
          else.
        </p>
        <p className="text-xs text-muted">
          Your manager can show you the shop&apos;s full written policy. This page records that you
          read this one and accepted it.
        </p>
      </section>
      <PolicyAccept />
    </main>
  );
}
