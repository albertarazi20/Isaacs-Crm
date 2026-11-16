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
      <main className="mx-auto max-w-lg px-5 py-16">
        <h1 className="text-xl font-semibold">This link isn&apos;t valid any more</h1>
        <p className="mt-2 text-muted">
          Ask your contact to send a fresh one — it takes them one click.
        </p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-lg px-5 py-10">
      <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{s.shop_name}</p>
      <h1 className="mt-1 text-2xl font-bold tracking-tight">Documents for {s.business_name}</h1>
      <p className="mt-2 text-sm text-muted">
        Statements, your signed application, ID and a voided check. PDFs or photos, up to 25 MB
        each. Files go straight to {s.rep_name || "your rep"} and nobody else.
      </p>
      {s.wanted.length > 0 && (
        <section className="mt-6 rounded-xl border border-border bg-surface p-4">
          <h2 className="text-sm font-semibold">Still needed</h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {s.wanted.map((w) => (
              <li
                key={`${w.kind}-${w.period ?? ""}`}
                className="rounded-full border border-border px-3 py-1 text-sm"
              >
                {w.label}
              </li>
            ))}
          </ul>
        </section>
      )}
      <UploadForm token={s.token} />
      <p className="mt-8 text-xs text-muted">
        This link works for two hours. Everything you send is stored privately and shared only with
        the lenders reviewing your file.
      </p>
    </main>
  );
}
