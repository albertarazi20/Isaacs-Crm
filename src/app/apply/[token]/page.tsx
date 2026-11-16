import { ApplicationForm } from "@/components/apply/ApplicationForm";
import { db } from "@/lib/db";
import { openApplicationPage } from "@/lib/docs/apply";

export const dynamic = "force-dynamic";

/**
 * The merchant's application page. No sign-in: the token is the key. The owner sees and signs their own
 * application here; nothing on the page names other merchants or the rep's pipeline.
 */
export default async function ApplyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const a = await openApplicationPage(db, token);
  if (!a) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16">
        <h1 className="text-xl font-semibold">This link isn&apos;t valid any more</h1>
        <p className="mt-2 text-muted">
          Ask your contact to send a fresh one — it takes them one click.
        </p>
      </main>
    );
  }
  if (a.signed_at) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16">
        <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">
          {a.shop_name}
        </p>
        <h1 className="mt-1 text-xl font-semibold">Your application is already in</h1>
        <p className="mt-2 text-muted">
          {a.business_name}&apos;s application was signed on {a.signed_at.slice(0, 10)}.{" "}
          {a.rep_name} has it. If something changed, tell them and they will send a fresh link.
        </p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-lg px-5 py-10">
      <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{a.shop_name}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Funding application</h1>
      <p className="mt-2 text-sm text-muted">
        For {a.business_name}. Five minutes, a soft inquiry only. {a.rep_name} sees it the moment
        you sign.
      </p>
      <ApplicationForm
        token={a.token}
        prefill={{
          legal_business_name: a.business_name,
          owner_name: a.contact_name,
          phone: a.phone,
          email: a.email,
          state: a.state,
          industry: a.industry,
          monthly_revenue_dollars: a.monthly_revenue_dollars ?? undefined,
          amount_requested_dollars: a.wanted_amount_dollars ?? undefined,
        }}
      />
    </main>
  );
}
