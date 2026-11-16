"use client";

import { CAN, type Role } from "@/lib/auth/roles";
import type { ClientDetail } from "@/lib/data/types";
import type { ClientFundersData } from "@/lib/funders/types";
import type { MerchantApplication } from "@/lib/leads/application";
import { ApplicationCard } from "./ApplicationCard";
import { AskCard } from "./AskCard";
import { ClientDetails, StickyBar } from "./ClientHeader";
import { FollowUpPanel } from "./FollowUpPanel";
import { FundingCard } from "./FundingCard";
import { OffersCard } from "./OffersCard";
import { NowProvider } from "./parts";
import { PositionsCard } from "./PositionsCard";
import { StipsCard } from "./StipsCard";
import { SubmissionsCard } from "./SubmissionsCard";
import { NotesPanel, Timeline } from "./Timeline";

/**
 * Desktop: timeline left, panels right. Phone: one column in this order — pinned header, last call and
 * note box (he is on the phone with the merchant), details, follow-up, funding, history, then the rest
 * — which the `order-*` classes set (the wrappers are `contents` there).
 */
export function ClientView({
  detail,
  serverNow,
  funders,
  role,
  application,
  appUrl,
}: {
  detail: ClientDetail;
  serverNow: number;
  funders?: ClientFundersData;
  /** The merchant's application link token and latest signed application; absent where the page has none to show. */
  application?: MerchantApplication | null;
  appUrl?: string;
  /** The viewer's role: reps and managers get "Submit to ops"; ops does not (it is their own queue). */
  role?: Role;
}) {
  const { card } = detail;
  const canSubmitToOps = role !== undefined && CAN.workLeads(role);
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
            <FundingCard fundings={detail.fundings} timers={detail.timers} className="order-4" />
            {funders ? (
              <SubmissionsCard
                card={card}
                data={funders}
                positions={detail.positions}
                stips={detail.stips}
                canSubmitToOps={canSubmitToOps}
                className="order-6"
              />
            ) : null}
            <AskCard clientId={card.id} asks={detail.asks} className="order-6" />
            <PositionsCard clientId={card.id} positions={detail.positions} className="order-7" />
            <OffersCard clientId={card.id} offers={detail.offers} className="order-8" />
            <StipsCard clientId={card.id} stips={detail.stips} className="order-9" />
          </div>
        </div>
      </div>
    </NowProvider>
  );
}
