"use client";

import { Glyph } from "@/components/shell/icons";
import type { Recommendation } from "@/lib/assistant/recommendations";
import { PLAN_MY_DAY } from "@/lib/assistant/prompts";
import { useAssistant } from "./Assistant";
import { RecommendationCards } from "./RecommendationCards";

/** The Overview's "Recommended next": the workflows worth doing now, each one click from a plan. */
export function OverviewRecommendations({
  items,
  ready,
}: {
  items: Recommendation[];
  ready: boolean;
}) {
  const ask = useAssistant();
  return (
    <section aria-labelledby="recommended-heading" className="animate-rise space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="recommended-heading" className="text-[15px] font-semibold tracking-tight">
            Recommended next
          </h2>
          <p className="text-[12.5px] text-muted">
            Click Plan it and the assistant reads the merchants, writes the steps, and sets up the
            actions.
          </p>
        </div>
        <button
          type="button"
          disabled={!ready}
          onClick={() => ask({ prompt: PLAN_MY_DAY, send: true, fresh: true })}
          className="inline-flex h-10 items-center gap-2 rounded-full border border-border bg-surface px-4 text-[13px] font-semibold shadow-card transition duration-150 hover:border-accent/50 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 sm:h-9"
        >
          <Glyph name="target" className="size-4 text-accent" />
          Plan my day
        </button>
      </div>
      {items.length > 0 ? (
        <RecommendationCards
          items={items}
          ready={ready}
          onPlan={(r) => ask({ prompt: r.prompt, send: true, fresh: true })}
        />
      ) : (
        <p className="rounded-2xl border border-dashed border-border-strong/70 px-4 py-6 text-center text-[13px] text-muted">
          Nothing is waiting on you. Add the next lead, or ask the assistant to look for merchants
          worth a call.
        </p>
      )}
    </section>
  );
}
