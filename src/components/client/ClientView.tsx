"use client";

import type { ClientDetail } from "@/lib/data/types";
import { AskCard } from "./AskCard";
import { ClientDetails, StickyBar } from "./ClientHeader";
import { FollowUpPanel } from "./FollowUpPanel";
import { FundingCard } from "./FundingCard";
import { OffersCard } from "./OffersCard";
import { NowProvider } from "./parts";
import { PositionsCard } from "./PositionsCard";
import { StipsCard } from "./StipsCard";
import { Timeline } from "./Timeline";

/**
 * Desktop: timeline left, panels right. Phone: one column in this order — follow-up, funding,
 * notes, then the rest — which the `order-*` classes set (the right column is `contents` there).
 */
export function ClientView({ detail, serverNow }: { detail: ClientDetail; serverNow: number }) {
  const { card } = detail;
  return (
    <NowProvider serverNow={serverNow}>
      <div className="space-y-4">
        <StickyBar card={card} />
        <ClientDetails detail={detail} />
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
          <div className="order-3 lg:order-none">
            <Timeline card={card} activities={detail.activities} />
          </div>
          <div className="contents lg:flex lg:flex-col lg:gap-4">
            <FollowUpPanel detail={detail} className="order-1" />
            <FundingCard fundings={detail.fundings} timers={detail.timers} className="order-2" />
            <AskCard clientId={card.id} asks={detail.asks} className="order-4" />
            <PositionsCard clientId={card.id} positions={detail.positions} className="order-5" />
            <OffersCard clientId={card.id} offers={detail.offers} className="order-6" />
            <StipsCard clientId={card.id} stips={detail.stips} className="order-7" />
          </div>
        </div>
      </div>
    </NowProvider>
  );
}
