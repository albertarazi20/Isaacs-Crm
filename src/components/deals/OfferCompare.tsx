import { Badge, Card, SectionTitle } from "@/components/ui";
import { TD, TH } from "@/components/deals/primitives";
import { FREQUENCY_WORD, type OfferMath } from "@/lib/funders/offers";
import { factorText } from "@/lib/funders/format";
import { formatMoney } from "@/lib/money";

/** "130 × $450 daily", or the count from the term when the lender gave no payment: "about 93 daily". */
function paymentsText(o: OfferMath): string {
  if (o.paymentCount === null) return "—";
  const freq = o.frequency ? FREQUENCY_WORD[o.frequency] : "";
  return o.paymentCents !== null
    ? `${o.paymentCount} × ${formatMoney(o.paymentCents)}${freq ? ` ${freq}` : ""}`
    : `about ${o.paymentCount}${freq ? ` ${freq}` : ""}`;
}

const commissionText = (o: OfferMath): string =>
  o.commissionCents === null
    ? "—"
    : `${formatMoney(o.commissionCents)}${o.commissionPoints !== null ? ` · ${o.commissionPoints} pts` : ""}`;

function BestMark() {
  return <Badge tone="good">Best</Badge>;
}

/**
 * Every live offer side by side, with the maths done on the server (compareOffers): what the merchant pays back,
 * what reaches their account after the lender's fees, and what we earn. The best offer carries the word "Best"
 * (lowest factor rate; a tie goes to the bigger advance). A table on a desktop, stacked cards on a phone.
 */
export function OfferCompare({ offers }: { offers: OfferMath[] }) {
  return (
    <Card className="p-0">
      <div className="px-4 pt-4 pb-3 sm:px-5">
        <SectionTitle
          aside={
            <span className="text-xs text-muted">
              {offers.length} {offers.length === 1 ? "offer" : "offers"} in play
            </span>
          }
        >
          Offer compare
        </SectionTitle>
      </div>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-[13px]">
          <thead className="bg-surface-2/60">
            <tr>
              <th className={TH}>Lender</th>
              <th className={`${TH} text-right`}>Advance</th>
              <th className={`${TH} text-right`}>Factor</th>
              <th className={`${TH} text-right`}>Payback</th>
              <th className={`${TH} text-right`}>Payments</th>
              <th className={`${TH} text-right`}>Fees</th>
              <th className={`${TH} text-right`}>Net to merchant</th>
              <th className={`${TH} text-right`}>Commission</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border border-t border-border">
            {offers.map((o) => (
              <tr
                key={o.offerId}
                data-compare-row={o.funderName}
                data-best={o.best ? "true" : undefined}
              >
                <td className={`${TD} font-medium`}>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {o.funderName}
                    {o.best ? <BestMark /> : null}
                  </span>
                </td>
                <td className={`${TD} text-right tabular-nums`}>{formatMoney(o.amountCents)}</td>
                <td className={`${TD} text-right tabular-nums`}>{factorText(o.factorRate)}</td>
                <td className={`${TD} text-right tabular-nums`}>
                  {formatMoney(o.paybackCents)}
                  <span className="block text-xs text-muted">costs {formatMoney(o.costCents)}</span>
                </td>
                <td className={`${TD} text-right whitespace-nowrap tabular-nums`}>
                  {paymentsText(o)}
                </td>
                <td className={`${TD} text-right tabular-nums`}>
                  {o.feesCents > 0 ? formatMoney(o.feesCents) : "—"}
                </td>
                <td className={`${TD} text-right tabular-nums`}>
                  {formatMoney(o.netToMerchantCents)}
                </td>
                <td className={`${TD} text-right whitespace-nowrap tabular-nums`}>
                  {commissionText(o)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-border border-t border-border sm:hidden">
        {offers.map((o) => (
          <li key={o.offerId} className="px-4 py-3" data-compare-card={o.funderName}>
            <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
              {o.funderName}
              {o.best ? <BestMark /> : null}
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {(
                [
                  ["Advance", formatMoney(o.amountCents)],
                  ["Factor", factorText(o.factorRate)],
                  ["Payback", formatMoney(o.paybackCents)],
                  ["Payments", paymentsText(o)],
                  ["Fees", o.feesCents > 0 ? formatMoney(o.feesCents) : "—"],
                  ["Net to merchant", formatMoney(o.netToMerchantCents)],
                  ["Commission", commissionText(o)],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd className="font-medium tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <p className="border-t border-border px-4 py-2.5 text-xs text-muted sm:px-5">
        Best is the lowest factor rate. Net to merchant is the advance less the lender&apos;s fees;
        commission is our points on the advance.
      </p>
    </Card>
  );
}
