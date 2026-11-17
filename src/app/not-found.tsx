import Link from "next/link";
import { MerchantNotice, MerchantShell } from "@/components/upload/MerchantShell";
import { buttonClass } from "@/components/ui";

/** Any address the app does not have. */
export default function NotFound() {
  return (
    <MerchantShell>
      <MerchantNotice icon="search" title="That page isn't here">
        The link may be old, or the address has a typo.
      </MerchantNotice>
      <div className="mt-5 flex justify-center">
        <Link href="/" className={buttonClass("primary", "lg")}>
          Back to the start
        </Link>
      </div>
    </MerchantShell>
  );
}
