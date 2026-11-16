import Link from "next/link";
import { ImportWizard } from "@/components/ImportWizard";

// Importing a few thousand merchants is one server action; give it room instead of the plan default.
export const maxDuration = 60;

export default function ImportPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="min-w-0">
        <Link
          href="/clients"
          className="inline-flex min-h-8 items-center text-sm text-muted transition hover:text-text"
        >
          ← Clients
        </Link>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Import clients</h1>
        <p className="mt-0.5 text-sm text-muted">
          Bring in the merchants you already have. Every one gets a follow-up date so nobody falls
          through.
        </p>
      </div>
      <ImportWizard />
    </div>
  );
}
