import Link from "next/link";
import { ImportWizard } from "@/components/ImportWizard";

// Importing a few thousand merchants is one server action; give it room instead of the plan default.
export const maxDuration = 60;

export default function ImportPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <Link href="/clients" className="text-sm text-muted hover:text-text">
          ← Clients
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Import clients</h1>
        <p className="text-sm text-muted">
          Bring in the merchants you already have. Every one gets a follow-up date so nobody falls
          through.
        </p>
      </div>
      <ImportWizard />
    </div>
  );
}
