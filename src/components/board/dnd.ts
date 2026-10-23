import {
  closestCenter,
  PointerSensor,
  pointerWithin,
  type Announcements,
  type CollisionDetection,
  type PointerSensorOptions,
} from "@dnd-kit/core";
import type { KeyboardCoordinateGetter } from "@dnd-kit/core";
import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Mouse and pen only. A finger on the glass belongs to the touch sensor (press-and-hold to pick
 * up), otherwise a swipe to scroll the board would be mistaken for a drag.
 */
export class MouseAndPenSensor extends PointerSensor {
  static override activators = [
    {
      eventName: "onPointerDown" as const,
      handler: (
        { nativeEvent: e }: ReactPointerEvent,
        { onActivation }: PointerSensorOptions,
      ): boolean => {
        if (!e.isPrimary || e.button !== 0 || e.pointerType === "touch") return false;
        onActivation?.({ event: e });
        return true;
      },
    },
  ];
}

/** Under the pointer decides a mouse drop; with no pointer (keyboard), the nearest column does. */
export const collision: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);

/** Arrow keys hop a whole column at a time instead of nudging 25px. */
export const columnCoordinates: KeyboardCoordinateGetter = (
  event,
  { context: { collisionRect, droppableContainers, droppableRects } },
) => {
  if ((event.code !== "ArrowRight" && event.code !== "ArrowLeft") || !collisionRect) return;
  event.preventDefault();
  const centre = collisionRect.left + collisionRect.width / 2;
  const columns = droppableContainers
    .getEnabled()
    .map((c) => droppableRects.get(c.id))
    .filter((r) => r !== undefined)
    .sort((a, b) => a.left - b.left);
  const target =
    event.code === "ArrowRight"
      ? columns.find((r) => r.left + r.width / 2 > centre + 1)
      : columns.findLast((r) => r.left + r.width / 2 < centre - 1);
  if (!target) return;
  return {
    x: target.left + (target.width - collisionRect.width) / 2,
    y: collisionRect.top,
  };
};

interface Labelled {
  data: { current?: Record<string, unknown> | undefined };
}

const dataString = (o: Labelled, key: string, fallback: string): string => {
  const v = o.data.current?.[key];
  return typeof v === "string" && v !== "" ? v : fallback;
};

/** What a screen reader says during a drag, in stage and follow-up words rather than element ids. */
export function makeAnnouncements(noun: "stage" | "follow-up time"): Announcements {
  const name = (o: Labelled) => dataString(o, "name", "merchant");
  const where = (o: Labelled) => dataString(o, "label", noun);
  return {
    onDragStart: ({ active }) =>
      `Picked up ${name(active)}, currently in ${dataString(active, "from", "its column")}.`,
    onDragOver: ({ active, over }) =>
      over ? `${name(active)} is over ${where(over)}.` : `${name(active)} is not over a ${noun}.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `${name(active)} was dropped on ${where(over)}.`
        : `${name(active)} was dropped outside any ${noun}. Nothing changed.`,
    onDragCancel: ({ active }) => `Move cancelled. ${name(active)} stays where it was.`,
  };
}

export function makeInstructions(noun: "stage" | "follow-up time") {
  return {
    draggable: `To pick up a merchant card, press space or enter. Then use the left and right arrow keys to choose a ${noun}, and press space or enter to drop it. Press escape to cancel.`,
  };
}
