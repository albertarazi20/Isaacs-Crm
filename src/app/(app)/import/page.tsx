import type { Metadata } from "next";
import { ImportWizard } from "@/components/ImportWizard";
import { PageHeader } from "@/components/ui";

// Importing a few thousand merchants is one server action; give it room instead of the plan default.
export const maxDuration = 60;

export const metadata: Metadata = { title: "Import" };

export default function ImportPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        eyebrow="Merchants"
        title="Import a file"
        description="Bring in the merchants you already have. Every one gets a follow-up date so nobody falls through."
      />
      <ImportWizard />
    </div>
  );
}
