"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { purgeClientAction, restoreClientAction } from "@/app/actions";
import type { TrashedClient } from "@/lib/data/queries";
import { timeAgo } from "@/lib/format";
import { formatUS } from "@/lib/mca/phone";
import { stageDef } from "@/lib/mca/stages";
import { useApp } from "./app-context";
import { useCall } from "./overlay";
import { Button, Card, EmptyState } from "./ui";

export function TrashList({ items }: { items: TrashedClient[] }) {
  const router = useRouter();
  const call = useCall();
  const { nowMs } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function act(id: string, run: () => ReturnType<typeof restoreClientAction>, ok: string) {
    setBusy(id);
    const done = await call(run(), ok);
    setBusy(null);
    setConfirming(null);
    if (done !== null) router.refresh();
  }

  if (items.length === 0)
    return (
      <EmptyState title="The trash is empty">
        Clients you move to the trash show up here.
      </EmptyState>
    );

  return (
    <ul className="space-y-2">
      {items.map((c) => (
        <li key={c.id}>
          <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{c.business_name}</p>
              <p className="truncate text-sm text-muted">
                {[c.contact_name, formatUS(c.phone), stageDef(c.stage).label]
                  .filter(Boolean)
                  .join(" · ")}
                {" · "}trashed {timeAgo(c.trashed_at, new Date(nowMs))}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy === c.id}
                onClick={() =>
                  void act(
                    c.id,
                    () => restoreClientAction({ clientId: c.id }),
                    `${c.business_name} restored`,
                  )
                }
              >
                Restore
              </Button>
              {c.contact_status !== "ok" ? (
                <span
                  className="self-center text-sm text-muted"
                  title="A merchant who asked not to be contacted stays on file so they can't be added again as a new lead."
                >
                  Kept on file — do-not-contact
                </span>
              ) : (
                <>
                  {confirming === c.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy === c.id}
                        onClick={() =>
                          void act(
                            c.id,
                            () => purgeClientAction({ clientId: c.id }),
                            `${c.business_name} deleted for good`,
                          )
                        }
                      >
                        Yes, delete for good
                      </Button>
                      <Button size="sm" onClick={() => setConfirming(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="danger" onClick={() => setConfirming(c.id)}>
                      Delete forever
                    </Button>
                  )}
                </>
              )}
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}
