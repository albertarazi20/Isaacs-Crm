import Link from "next/link";
import { buttonClass } from "@/components/ui";

export default function ClientNotFound() {
  return (
    <div className="mx-auto max-w-md rounded-xl border border-dashed border-border p-10 text-center">
      <h1 className="text-lg font-semibold">Client not found</h1>
      <p className="mt-1 text-sm text-muted">
        It may have been deleted, or the link is wrong. Your other clients are all still there.
      </p>
      <Link href="/clients" className={buttonClass("primary", "md", "mt-5")}>
        Back to clients
      </Link>
    </div>
  );
}
