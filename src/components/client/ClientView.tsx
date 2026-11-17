"use client";

import type { ClientDetail } from "@/lib/data/types";
import type { Freshness } from "@/lib/docs/freshness";
import type { DocumentRow } from "@/lib/docs/upload";
import type { MerchantApplication } from "@/lib/leads/application";
import { ApplicationCard } from "./ApplicationCard";
import { ClientDetails, StickyBar } from "./ClientHeader";
import { DocumentsCard } from "./DocumentsCard";
import { FollowUpPanel } from "./FollowUpPanel";
import { NowProvider } from "./parts";
import { StipsCard } from "./StipsCard";
import { NotesPanel, Timeline } from "./Timeline";

/**
 * Desktop: timeline left, panels right. Phone: one column in this order — pinned header, last call and
 * note box (he is on the phone with the merchant), details, follow-up, documents, history, then the rest
 * — which the `order-*` classes set (the wrappers are `contents` there).
 */
export function ClientView({
  detail,
  serverNow,
  application,
  documents,
  freshness,
  today,
  appUrl,
}: {
  detail: ClientDetail;
  serverNow: number;
  /** The merchant's application link token and latest signed application; absent where the page has none to show. */
  application?: MerchantApplication | null;
  documents: DocumentRow[];
  freshness: Freshness;
  today: string;
  appUrl?: string;
}) {
  const { card } = detail;
  return (
    <NowProvider serverNow={serverNow}>
      <div className="flex min-w-0 flex-col gap-4">
        <StickyBar card={card} />
        <ClientDetails detail={detail} className="order-2 lg:order-1" />
        <div className="contents lg:order-2 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start lg:gap-4">
          <div className="contents lg:flex lg:flex-col lg:gap-4">
            <NotesPanel card={card} activities={detail.activities} className="order-1" />
            <Timeline activities={detail.activities} className="order-5" />
          </div>
          <div className="contents lg:flex lg:flex-col lg:gap-4">
            <FollowUpPanel detail={detail} application={application} className="order-3" />
            {application && appUrl ? (
              <ApplicationCard
                card={card}
                application={application}
                appUrl={appUrl}
                className="order-3"
              />
            ) : null}
            <DocumentsCard
              clientId={card.id}
              documents={documents}
              freshness={freshness}
              today={today}
              className="order-4"
            />
            <StipsCard clientId={card.id} stips={detail.stips} className="order-9" />
          </div>
        </div>
      </div>
    </NowProvider>
  );
}
