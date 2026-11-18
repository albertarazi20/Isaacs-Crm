/**
 * Round 5: a modal <dialog> makes everything outside it inert, so the toast stack and the reminder banner (top-layer
 * popovers) must move into the newest open modal to stay clickable. The choice of that modal is the pure part.
 */
import { describe, expect, it } from "vitest";
import { dropModal, pushModal, topModal } from "@/components/overlay";

const dlg = (name: string, open = true, isConnected = true) => ({ name, open, isConnected });

describe("which modal dialog the toasts move into", () => {
  it("is null with no modal open, so the stack stays where it is", () => {
    expect(topModal([])).toBeNull();
  });

  it("is the newest open modal: a dialog opened over a drawer wins", () => {
    const drawer = dlg("drawer");
    const confirm = dlg("confirm");
    const stack = pushModal(pushModal([], drawer), confirm);
    expect(topModal(stack)).toBe(confirm);
    // closing the top one hands the toasts back to the drawer underneath
    expect(topModal(dropModal(stack, confirm))).toBe(drawer);
    expect(topModal(dropModal(dropModal(stack, confirm), drawer))).toBeNull();
  });

  it("re-opening a dialog makes it the newest, and it is listed once", () => {
    const a = dlg("a");
    const b = dlg("b");
    const stack = pushModal(pushModal(pushModal([], a), b), a);
    expect(stack).toEqual([b, a]);
    expect(topModal(stack)).toBe(a);
  });

  it("skips a dialog that is closed or no longer on the page", () => {
    const live = dlg("live");
    const shut = dlg("shut", false);
    const removed = dlg("removed", true, false);
    expect(topModal([live, shut, removed])).toBe(live);
    expect(topModal([shut, removed])).toBeNull();
  });

  it("dropping a dialog that is not listed changes nothing", () => {
    const stack = [dlg("a")];
    expect(dropModal(stack, dlg("other"))).toBe(stack);
  });
});
