"use client";

import { useCall } from "@/components/overlay";

export { Badge, Button, EmptyState } from "@/components/ui";

/** The shared action caller (toasts on failure), under a name that says what it is for here. */
export const useCallSafe = useCall;
