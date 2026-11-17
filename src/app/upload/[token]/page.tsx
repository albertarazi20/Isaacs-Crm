import {
  MerchantHeading,
  MerchantNotice,
  MerchantShell,
  shopLabel,
} from "@/components/upload/MerchantShell";
import { UploadForm } from "@/components/upload/UploadForm";
import { db } from "@/lib/db";
import { openUploadPage } from "@/lib/docs/upload";
import { todayIn } from "@/lib/mca/dates";

export const dynamic = "force-dynamic";

/**
 * The merchant's upload page. No sign-in: the token is the key. A permanent link mints a two-hour session on open;
 * a link a rep texted is already a session. Nothing here names other merchants or the rep's pipeline.
 */
export default async function UploadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const s = await openUploadPage(db, token, todayIn("America/New_York"));
  if (!s) {
    return (
      <MerchantShell label="Documents">
        <MerchantNotice icon="link" tone="warn" title="This link isn't valid any more">
          Ask your contact to send a fresh one. It takes them one click.
        </MerchantNotice>
      </MerchantShell>
    );
  }
  return (
    <MerchantShell label="Documents">
      <MerchantHeading
        eyebrow={shopLabel(s.shop_name)}
        title={<>Documents for {s.business_name}</>}
      >
        Statements, your signed application, ID and a voided check. PDFs or photos, up to 25 MB
        each. Files go straight to {s.rep_name || "your rep"} and nobody else.
      </MerchantHeading>
      <UploadForm token={s.token} wanted={s.wanted} />
      <p className="mt-8 text-center text-xs leading-relaxed text-pretty text-muted">
        This link works for two hours. Everything you send is stored privately and shared only with
        the people working on your file.
      </p>
    </MerchantShell>
  );
}
