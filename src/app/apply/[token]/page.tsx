import { ApplicationForm } from "@/components/apply/ApplicationForm";
import {
  MerchantHeading,
  MerchantNotice,
  MerchantShell,
  shopLabel,
} from "@/components/upload/MerchantShell";
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
      <MerchantShell label="Application">
        <MerchantNotice icon="link" tone="warn" title="This link isn't valid any more">
          Ask your contact to send a fresh one. It takes them one click.
        </MerchantNotice>
      </MerchantShell>
    );
  }
  if (a.signed_at) {
    return (
      <MerchantShell label="Application">
        <MerchantNotice icon="check" tone="good" title="Your application is already in">
          {a.business_name}&apos;s application was signed on {a.signed_at.slice(0, 10)}.{" "}
          {a.rep_name} has it. If something changed, tell them and they will send a fresh link.
        </MerchantNotice>
      </MerchantShell>
    );
  }
  return (
    <MerchantShell label="Application" wide>
      <MerchantHeading eyebrow={shopLabel(a.shop_name)} title="Funding application">
        For {a.business_name}. Five minutes, a soft inquiry only. {a.rep_name} sees it the moment
        you sign.
      </MerchantHeading>
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
    </MerchantShell>
  );
}
