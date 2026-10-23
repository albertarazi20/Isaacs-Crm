export default function ClientLoading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading client">
      <div className="h-16 rounded-xl bg-surface-2" />
      <div className="h-24 rounded-xl bg-surface-2" />
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="h-96 rounded-xl bg-surface-2" />
        <div className="space-y-4">
          <div className="h-56 rounded-xl bg-surface-2" />
          <div className="h-40 rounded-xl bg-surface-2" />
        </div>
      </div>
    </div>
  );
}
