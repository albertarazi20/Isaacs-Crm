import { Skeleton } from "@/components/ui";

/** What shows the instant you pick a place in the sidebar, until the page's own data arrives. */
export default function AppLoading() {
  return (
    <div aria-busy aria-label="Loading" className="animate-fade space-y-5">
      <div className="space-y-2.5 pb-1">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-8 w-72 max-w-full rounded-xl" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-2xl border border-border bg-surface p-5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-4 h-9 w-24 rounded-xl" />
            <Skeleton className="mt-4 h-3 w-28" />
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-border bg-surface p-5">
        <Skeleton className="h-4 w-40" />
        <div className="mt-5 space-y-4">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-9 shrink-0 rounded-xl" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
