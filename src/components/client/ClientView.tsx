"use client";

import type { ApprovalRow } from "@/lib/approvals/queries";
import type { CadenceStep } from "@/lib/approvals/words";
import type { ClientDetail } from "@/lib/data/types";
import type { Freshness } from "@/lib/docs/freshness";
import type { DocumentRow } from "@/lib/docs/upload";
import type { MerchantApplication } from "@/lib/leads/application";
import { ApprovalCard } from "../approvals/ApprovalCard";
import { ApplicationCard } from "./ApplicationCard";
import { BringInStrip } from "./BringIn";
import { ClientHero, MobileActionBar } from "./ClientHeader";
import { DocumentsCard } from "./DocumentsCard";
import { FollowUpPanel } from "./FollowUpPanel";
import { NowProvider } from "./parts";
import { StipsCard } from "./StipsCard";
import { NotesPanel, Timeline } from "./Timeline";

/**
 * One merchant, worked until the file is in. Wide screen: the hero, the "Bringing them in" strip, then the story on
 * the left (note box, timeline) and the working rail on the right (follow-up, documents, application, stips).
 * Phone: one column, most important first (hero, note box, progress, follow-up, documents, application, timeline,
 * stips), which the `order-*` classes set (the two column wrappers are `contents` there), with call, text and email
 * in a glass bar pinned to the bottom. The note box sits above the progress strip on a phone so it is on the first
 * screen: a rep on a call writes before anything else.
 */
export function ClientView({
  detail,
  serverNow,
  application,
  documents,
  freshness,
  today,
  appUrl,
  approval = null,
  cadence = [],
  buckets = [],
  bucketId = null,
}: {
  detail: ClientDetail;
  serverNow: number;
  /** The merchant's application link token and latest signed application; absent where the page has none to show. */
  application?: MerchantApplication | null;
  documents: DocumentRow[];
  freshness: Freshness;
  today: string;
  appUrl?: string;
  /** The merchant's open approval, else their latest one. */
  approval?: ApprovalRow | null;
  cadence?: readonly CadenceStep[];
  /** The follow-up buckets to move this merchant between, and the one they are in. */
  buckets?: readonly { id: string; name: string }[];
  bucketId?: string | null;
}) {
  const { card } = detail;
  return (
    <NowProvider serverNow={serverNow}>
      {/* first in the page so the phone's own copy of the buttons is the first one found */}
      <MobileActionBar card={card} />
      <div className="stagger flex min-w-0 flex-col gap-4 max-sm:pb-10 lg:gap-5">
        <ClientHero detail={detail} buckets={buckets} bucketId={bucketId} />
        <div className="flex flex-col gap-4 xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)] xl:items-start xl:gap-5">
          <BringInStrip
            detail={detail}
            application={application}
            documents={documents}
            className="max-sm:order-2 xl:col-span-2"
          />
          <ApprovalCard
            merchant={{ id: card.id, name: card.business_name || card.contact_name }}
            approval={approval}
            cadence={cadence}
            broughtIn={detail.bringIn.brought_in_at !== null}
            className="max-sm:order-2 xl:col-span-2"
          />
          <div className="contents xl:flex xl:min-w-0 xl:flex-col xl:gap-5">
            <NotesPanel card={card} activities={detail.activities} className="order-1" />
            <Timeline
              activities={detail.activities}
              merchant={{ id: card.id, name: card.business_name || card.contact_name }}
              className="order-5"
            />
          </div>
          <div className="contents xl:flex xl:min-w-0 xl:flex-col xl:gap-5">
            <FollowUpPanel detail={detail} application={application} className="order-2" />
            <DocumentsCard
              clientId={card.id}
              documents={documents}
              freshness={freshness}
              today={today}
              className="order-3"
            />
            {application && appUrl ? (
              <ApplicationCard
                card={card}
                application={application}
                appUrl={appUrl}
                className="order-4"
              />
            ) : null}
            <StipsCard clientId={card.id} stips={detail.stips} className="order-6" />
          </div>
        </div>
      </div>
    </NowProvider>
  );
}
