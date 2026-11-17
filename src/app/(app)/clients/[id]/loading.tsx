import { Skeleton } from "@/components/ui";

const PANEL = "rounded-2xl border border-border bg-surface p-4 sm:p-5";

/** The merchant page while it loads: the same hero, strip and two columns, as shimmer. */
export default function ClientLoading() {
  return (
    <div
      className="flex min-w-0 flex-col gap-4 lg:gap-5"
      aria-busy="true"
      aria-label="Loading merchant"
    >
      <div className="overflow-hidden rounded-3xl border border-border bg-surface">
        <div className="flex flex-wrap items-start gap-x-5 gap-y-4 p-4 sm:p-6">
          <Skeleton className="size-12 rounded-2xl sm:size-[60px]" />
          <div className="min-w-0 flex-1 basis-64 space-y-2.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-8 w-64 max-w-full rounded-lg" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
          <div className="flex gap-1.5 max-sm:hidden">
            <Skeleton className="h-9 w-20 rounded-full" />
            <Skeleton className="h-9 w-20 rounded-full" />
            <Skeleton className="h-9 w-20 rounded-full" />
          </div>
          <div className="flex w-full flex-wrap gap-2">
            <Skeleton className="h-8 w-36 rounded-full" />
            <Skeleton className="h-8 w-48 rounded-full" />
            <Skeleton className="h-8 w-32 rounded-full" />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border bg-surface-3/50 px-4 py-3 sm:px-6">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-8 w-40 rounded-full max-sm:hidden" />
        </div>
      </div>
      <div className={`${PANEL} flex flex-col gap-4 xl:flex-row xl:items-center xl:gap-6`}>
        <div className="space-y-2 xl:w-56">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-6 w-36 rounded-lg" />
        </div>
        <div className="grid flex-1 gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-11 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3 w-32 max-w-full" />
              </div>
            </div>
          ))}
        </div>
        <Skeleton className="h-12 w-36 rounded-full max-sm:w-full" />
      </div>
      <div className="flex flex-col gap-4 xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)] xl:items-start xl:gap-5">
        <div className="flex flex-col gap-4 xl:gap-5">
          <div className={`${PANEL} space-y-3`}>
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="ml-auto h-9 w-28 rounded-full" />
          </div>
          <div className={`${PANEL} space-y-5`}>
            <Skeleton className="h-4 w-24" />
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="size-7 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-4 xl:gap-5">
          <div className={`${PANEL} space-y-3`}>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-24 w-full rounded-2xl" />
            <Skeleton className="h-8 w-full rounded-full" />
          </div>
          <div className={`${PANEL} space-y-3`}>
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-28 w-full rounded-2xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
