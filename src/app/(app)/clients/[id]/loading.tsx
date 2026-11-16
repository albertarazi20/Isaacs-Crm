export default function ClientLoading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading client">
      <div className="h-16 rounded-xl border border-border bg-surface-2" />
      <div className="h-24 rounded-xl border border-border bg-surface-2" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-4">
          <div className="h-14 rounded-xl border border-border bg-surface-2" />
          <div className="h-28 rounded-xl border border-border bg-surface-2" />
          <div className="h-80 rounded-xl border border-border bg-surface-2" />
        </div>
        <div className="space-y-4">
          <div className="h-56 rounded-xl border border-border bg-surface-2" />
          <div className="h-40 rounded-xl border border-border bg-surface-2" />
        </div>
      </div>
    </div>
  );
}
