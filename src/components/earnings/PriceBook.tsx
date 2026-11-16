"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  MIN_SAMPLE,
  SOURCE_LABELS,
  fromSource,
  funderSlice,
  groupFactors,
  industrySlice,
  positionOrder,
  positionSlice,
  type LossGap,
  type PriceGroup,
  type PriceObservation,
  type PriceSource,
  meanFactor,
} from "@/lib/earnings/pricebook";
import { factorInput } from "@/lib/earnings/terms";
import { chipClass } from "../settings/primitives";
import { Card, cn, EmptyState, SectionTitle } from "../ui";

const SOURCES: PriceSource[] = ["funded", "offer", "competitor"];
const SHOWN = 8;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** 0.04 → "0.04", 0.035 → "0.035". */
const gapText = (g: number) => {
  const s = Math.abs(g).toFixed(3);
  return s.endsWith("0") ? s.slice(0, -1) : s;
};

function GroupTable({
  title,
  groups,
  empty,
}: {
  title: string;
  groups: PriceGroup[];
  empty: string;
}) {
  const [all, setAll] = useState(false);
  const rows = all ? groups : groups.slice(0, SHOWN);
  return (
    <div className="min-w-0">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {groups.length === 0 ? (
        <p className="mt-1 text-sm text-muted">{empty}</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-[13px] tabular-nums">
            <thead className="bg-surface-2/60 text-left text-[11px] font-semibold tracking-wide text-muted uppercase">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-semibold">
                  {title.replace(/^By /, "")}
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-semibold">
                  Based on
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-semibold">
                  Average factor
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-semibold">
                  Range
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((g) => (
                <tr key={g.key} className="transition hover:bg-surface-3">
                  <th scope="row" className="max-w-40 truncate px-3 py-1.5 text-left font-medium">
                    {g.label}
                  </th>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap text-muted">
                    {plural(g.n, "price")}
                  </td>
                  <td className="px-2 py-1.5 text-right font-semibold">
                    {g.average === null ? (
                      <span
                        className="font-normal text-muted"
                        title={`Needs prices from at least ${MIN_SAMPLE} different merchants before an average means anything`}
                      >
                        too few
                      </span>
                    ) : (
                      factorInput(g.average)
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap text-muted">
                    {g.n < 2 ? "—" : `${factorInput(g.low)}–${factorInput(g.high)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {groups.length > SHOWN ? (
        <button
          type="button"
          className="mt-1.5 text-xs font-medium text-accent hover:underline"
          onClick={() => setAll((v) => !v)}
        >
          {all ? "Show fewer" : `Show all ${groups.length}`}
        </button>
      ) : null}
    </div>
  );
}

function LossGapPanel({ loss, hasOffers }: { loss: LossGap; hasOffers: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-surface-3 p-3.5">
      <h3 className="text-[13px] font-semibold">Deals you lost: how far off was your price?</h3>
      {loss.deals.length === 0 ? (
        <p className="mt-1 text-sm text-muted">
          No lost deal has a competing offer logged yet. When you move a deal to Lost, enter what
          the other funder offered and it will be compared with your best offer here.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm">
            {loss.averageGap !== null ? (
              <>
                Across {plural(loss.compared, "lost deal")} with both prices, the winner&apos;s
                factor averaged{" "}
                <strong>
                  {loss.averageGap === 0
                    ? "the same as"
                    : `${gapText(loss.averageGap)} ${loss.averageGap < 0 ? "below" : "above"}`}
                </strong>{" "}
                your best offer. They were cheaper on {loss.cheaper}, pricier on {loss.pricier}
                {loss.same > 0 ? `, level on ${loss.same}` : ""}.
              </>
            ) : !hasOffers ? (
              <span className="text-muted">
                Your own offers aren&apos;t logged yet, so there is nothing to compare the winning
                price with. Log offers on the Funders page and this fills in.
              </span>
            ) : (
              <span className="text-muted">
                {loss.compared === 0
                  ? "None of these has an offer of yours logged to compare with."
                  : `Only ${plural(loss.compared, "lost deal")} ${loss.compared === 1 ? "has" : "have"} both a competing offer and one of yours — at least ${MIN_SAMPLE} are needed before this means anything.`}
              </span>
            )}
          </p>
          <ul className="mt-2 divide-y divide-border text-sm">
            {loss.deals.map((d) => (
              <li
                key={d.clientId}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2"
              >
                <Link
                  href={`/clients/${d.clientId}`}
                  className="truncate font-medium hover:underline"
                >
                  {d.businessName}
                </Link>
                <span className="text-xs text-muted tabular-nums">
                  {d.competitorFunder} {factorInput(d.competitorFactor)}
                  {" · "}
                  {d.ourBestFactor === null
                    ? "no offer of yours logged"
                    : `yours ${factorInput(d.ourBestFactor)}`}
                  {d.gap === null || d.gap === 0 ? null : (
                    <span
                      className={cn("ml-1.5 font-semibold", d.gap < 0 ? "text-bad" : "text-good")}
                    >
                      {d.gap < 0 ? `${gapText(d.gap)} cheaper` : `${gapText(d.gap)} dearer`}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Factor rates he has seen, from his own advances and offers — never from the internet. Every figure shows its sample size. */
export function PriceBook({
  observations,
  loss,
  hasOffers,
}: {
  observations: PriceObservation[];
  loss: LossGap;
  hasOffers: boolean;
}) {
  const counts = useMemo(
    () =>
      Object.fromEntries(
        SOURCES.map((s) => [s, observations.filter((o) => o.source === s).length]),
      ),
    [observations],
  );
  const [on, setOn] = useState<ReadonlySet<PriceSource>>(() => new Set(SOURCES));
  const chosen = useMemo(() => fromSource(observations, on), [observations, on]);
  const byPosition = useMemo(() => positionOrder(groupFactors(chosen, positionSlice)), [chosen]);
  const byIndustry = useMemo(() => groupFactors(chosen, industrySlice), [chosen]);
  const byFunder = useMemo(() => groupFactors(chosen, funderSlice), [chosen]);
  const overall = meanFactor(chosen.map((o) => o.factor));
  const chosenMerchants = new Set(chosen.map((o) => o.clientId)).size;

  function toggle(s: PriceSource) {
    setOn((cur) => {
      const next = new Set(cur);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  return (
    <Card className="min-w-0 space-y-4 p-4">
      <SectionTitle>Price book</SectionTitle>
      {observations.length === 0 ? (
        <EmptyState title="No prices to learn from yet">
          Fund an advance, log what a funder offered, or record the competitor on a lost deal. Every
          factor rate you enter lands here.
        </EmptyState>
      ) : (
        <>
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label="Prices to include"
          >
            {SOURCES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={on.has(s)}
                disabled={counts[s] === 0}
                onClick={() => toggle(s)}
                className={chipClass(
                  on.has(s) && counts[s] !== 0,
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                {SOURCE_LABELS[s]} ({counts[s]})
              </button>
            ))}
          </div>
          <p className="text-sm">
            {chosenMerchants >= MIN_SAMPLE && overall !== null ? (
              <>
                Based on {plural(chosen.length, "price")} from {plural(chosenMerchants, "merchant")}
                , the average factor rate is <strong>{factorInput(overall)}</strong>.
              </>
            ) : (
              <span className="text-muted">
                {chosen.length === 0
                  ? "Pick at least one kind of price above."
                  : `Only ${plural(chosen.length, "price")} from ${plural(chosenMerchants, "merchant")} so far — prices from at least ${MIN_SAMPLE} different merchants are needed before an average means anything.`}
              </span>
            )}
          </p>
          <div className="grid min-w-0 gap-5 lg:grid-cols-3">
            <GroupTable
              title="By position"
              groups={byPosition}
              empty="No prices with a position entered."
            />
            <GroupTable
              title="By industry"
              groups={byIndustry}
              empty="No prices on a merchant with an industry entered."
            />
            <GroupTable
              title="By funder"
              groups={byFunder}
              empty="No prices with a funder named."
            />
          </div>
        </>
      )}
      <LossGapPanel loss={loss} hasOffers={hasOffers} />
      <p className="text-xs text-muted">
        These are the prices you have entered, not the market. A price from a different mix of
        merchants, positions or months is not the same price.
      </p>
    </Card>
  );
}
