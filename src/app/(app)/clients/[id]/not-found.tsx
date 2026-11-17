import Link from "next/link";
import { buttonClass, PageHeader } from "@/components/ui";

export default function ClientNotFound() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Merchants"
        title="Merchant not found"
        description="This link does not lead to a merchant you can open."
      />
      <div className="rounded-3xl border border-dashed border-border-strong/70 bg-surface-3/40 px-6 py-14 text-center">
        <div
          aria-hidden
          className="bg-brand-soft mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl ring-1 ring-accent/20"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-6 text-accent"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.6-3.6M8.5 11h5" />
          </svg>
        </div>
        <p className="text-base font-semibold tracking-tight">Nothing at this address</p>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">
          It may have been moved to the trash, merged into another merchant, or it belongs to
          another rep. Your other merchants are all still there.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link href="/clients" className={buttonClass("primary", "md")}>
            Back to merchants
          </Link>
          <Link href="/trash" className={buttonClass("secondary", "md")}>
            Look in the trash
          </Link>
        </div>
      </div>
    </div>
  );
}
