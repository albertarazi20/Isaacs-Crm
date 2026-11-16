"use client";

import { useApp } from "@/components/app-context";
import { copyText } from "@/components/client/parts";
import { Icon } from "@/components/deals/primitives";
import { useToast } from "@/components/overlay";
import { Button, Card, SectionTitle, buttonClass } from "@/components/ui";
import { formatDate } from "@/lib/format";

/**
 * The merchant's application (0530): the link they open and sign on any device (copy it into a text or email),
 * and the latest signed one with its PDF, which also sits in the documents below once signed.
 */
export function ApplicationCard({
  link,
  latest,
}: {
  link: string;
  latest: { signerName: string; signedAt: string; documentId: string | null } | null;
}) {
  const { today } = useApp();
  const toast = useToast();
  return (
    <Card className="p-4 sm:p-5">
      <SectionTitle>Application</SectionTitle>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-text-2">Application link</p>
          <p className="mt-1 flex items-center gap-2">
            <code
              className="min-w-0 flex-1 truncate rounded-md bg-surface-2 px-2 py-1 text-xs"
              title={link}
            >
              {link}
            </code>
            <Button
              size="sm"
              onClick={async () =>
                toast(
                  (await copyText(link))
                    ? { message: "Application link copied", tone: "success" }
                    : {
                        message: "Couldn't copy — select the link and press Ctrl+C",
                        tone: "error",
                      },
                )
              }
            >
              <Icon name="copy" className="size-3.5 text-muted" />
              Copy application link
            </Button>
          </p>
          <p className="mt-1 text-xs text-muted">
            The merchant fills it in and signs on any device. No login.
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-text-2">Latest signed application</p>
          {latest ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span>
                Signed by <span className="font-medium">{latest.signerName}</span> on{" "}
                {formatDate(latest.signedAt.slice(0, 10), today)}
              </span>
              {latest.documentId ? (
                <a
                  href={`/api/docs/${latest.documentId}`}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonClass("secondary", "sm")}
                >
                  <Icon name="external" className="size-3.5 text-muted" />
                  Open PDF
                </a>
              ) : null}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted">Not signed yet.</p>
          )}
        </div>
      </div>
    </Card>
  );
}
