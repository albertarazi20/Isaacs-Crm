import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions", () => ({ logTouchAction: vi.fn(), sendEmailAction: vi.fn() }));
vi.mock("@/app/theme-actions", () => ({ setThemeAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { advancedNow, dayHasPassed } from "@/components/app-context";
import { callToast, pendingChange } from "@/components/ContactActions";
import { startCountUp, type CountUpEnv } from "@/components/fx";
import { isBackdropClick, listenEscape, runCall, ToastProvider } from "@/components/overlay";
import { showSystemNotification } from "@/components/ReminderWatcher";
import { nextTheme } from "@/components/ThemeSwitch";
import { Field } from "@/components/ui";

describe("frontend-ui-1: toasts live in the top layer", () => {
  it("renders the toast stack as a manual popover so a modal dialog cannot cover it", () => {
    const html = renderToStaticMarkup(createElement(ToastProvider, null, "page"));
    expect(html).toMatch(/<div[^>]*popover="manual"[^>]*aria-live="polite"/);
    // the browser's popover box is reset to a bare strip pinned to the bottom
    expect(html).toContain("top-auto");
    expect(html).toContain("bg-transparent");
  });
});

describe("frontend-ui-2: the pending-touch prompt keeps a draft", () => {
  const a = { clientId: "c1", stage: "name_in", name: "A", kind: "call", at: 1000 } as const;
  it("opens for a new touch", () => {
    expect(pendingChange(null, a)).toBe("open");
    expect(pendingChange(a, { ...a, at: 2000 })).toBe("open");
    expect(pendingChange(a, { ...a, clientId: "c2" })).toBe("open");
  });
  it("leaves the open dialog alone when the same touch is seen again or storage is empty", () => {
    expect(pendingChange(a, { ...a })).toBe("keep");
    expect(pendingChange(a, null)).toBe("keep");
    expect(pendingChange(null, null)).toBe("keep");
  });
});

describe("frontend-ui-3: a rejected action becomes a toast, not a stuck button", () => {
  it("toasts and resolves to null when the action promise rejects", async () => {
    const toast = vi.fn();
    const out = await runCall(toast, Promise.reject(new Error("offline")), "Sent");
    expect(out).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });
  it("toasts the server's error and the success text", async () => {
    const toast = vi.fn();
    expect(
      await runCall(toast, Promise.resolve({ ok: false as const, error: "Quota" })),
    ).toBeNull();
    expect(toast).toHaveBeenLastCalledWith({ message: "Quota", tone: "error" });
    expect(await runCall(toast, Promise.resolve({ ok: true as const, data: 5 }), "Done")).toBe(5);
    expect(toast).toHaveBeenLastCalledWith({ message: "Done", tone: "success" });
  });
});

describe("frontend-ui-4: a drag that ends on the backdrop does not close the dialog", () => {
  const dialog = new EventTarget();
  const field = new EventTarget();
  it("closes on a press and release both on the backdrop", () => {
    expect(isBackdropClick(true, dialog, dialog)).toBe(true);
  });
  it("does not close when the press started inside the dialog", () => {
    expect(isBackdropClick(false, dialog, dialog)).toBe(false);
  });
  it("does not close for a click on something inside, or with no target", () => {
    expect(isBackdropClick(true, field, dialog)).toBe(false);
    expect(isBackdropClick(true, null, dialog)).toBe(false);
  });
});

describe("frontend-ui-5: CountUp always lands on its current value", () => {
  function fakeEnv(reduced = false) {
    const frames: ((t: number) => void)[] = [];
    let clock = 0;
    const env: CountUpEnv = {
      now: () => clock,
      raf: (cb) => frames.push(cb),
      cancel: () => undefined,
      reducedMotion: reduced,
    };
    return {
      env,
      step: (ms: number) => {
        clock += ms;
        frames.splice(0).forEach((f) => f(clock));
      },
    };
  }
  it("shows 0 after a value that animated to 5 changes to 0", () => {
    const el = { textContent: "5" };
    const { env, step } = fakeEnv();
    const stop = startCountUp(el, 5, 0, "", "", env);
    step(1000);
    expect(el.textContent).toBe("5");
    stop();
    startCountUp(el, 0, 0, "", "", env);
    expect(el.textContent).toBe("0");
  });
  it("counts up to the final text, with prefix and suffix", () => {
    const el = { textContent: "" };
    const { env, step } = fakeEnv();
    startCountUp(el, 1200, 0, "$", "k", env);
    step(450);
    expect(el.textContent).toMatch(/^\$\d[\d,]*k$/);
    expect(el.textContent).not.toBe("$1,200k");
    step(900);
    expect(el.textContent).toBe("$1,200k");
  });
  it("writes the value at once when motion is reduced", () => {
    const el = { textContent: "old" };
    startCountUp(el, 7, 0, "", "", fakeEnv(true).env);
    expect(el.textContent).toBe("7");
  });
});

// children are passed as createElement arguments, so the props here have none
const fieldProps = (p: { label: string; group?: boolean }) => p as ComponentProps<typeof Field>;

describe("frontend-ui-7: a multi-button control is not wrapped in a label", () => {
  it("renders a labelled group, not a <label>, for group fields", () => {
    const html = renderToStaticMarkup(
      createElement(
        Field,
        fieldProps({ label: "Follow up again", group: true }),
        createElement("button", null, "1w"),
      ),
    );
    expect(html).not.toContain("<label");
    expect(html).toMatch(/role="group" aria-labelledby="([^"]+)"/);
    const id = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`id="${id}"`);
  });
  it("keeps the plain <label> for single inputs", () => {
    const html = renderToStaticMarkup(
      createElement(Field, fieldProps({ label: "Subject" }), createElement("input")),
    );
    expect(html.startsWith("<label")).toBe(true);
  });
});

describe("frontend-ui-8: a tab left open keeps the right day and time", () => {
  it("moves the server's clock forward by the time the tab has run", () => {
    expect(advancedNow(1_000_000, 50, 90_050)).toBe(1_090_000);
  });
  it("never runs backwards if the device clock is set back", () => {
    expect(advancedNow(1_000_000, 500, 100)).toBe(1_000_000);
  });
  it("notices midnight in the shop's time zone", () => {
    const evening = Date.parse("2026-11-18T23:50:00-05:00");
    expect(dayHasPassed("2026-11-18", "America/New_York", evening)).toBe(false);
    expect(dayHasPassed("2026-11-18", "America/New_York", evening + 20 * 60_000)).toBe(true);
  });
});

describe("frontend-ui-10: a notification that cannot be built does not vanish silently", () => {
  it("shows it with the constructor when that works", async () => {
    const made: string[] = [];
    class N {
      constructor(title: string) {
        made.push(title);
      }
    }
    expect(await showSystemNotification("Call A now", {}, { Notification: N })).toBe(true);
    expect(made).toEqual(["Call A now"]);
  });
  it("falls back to the service worker when the constructor throws (Android Chrome)", async () => {
    const shown: string[] = [];
    class N {
      constructor() {
        throw new TypeError("Illegal constructor");
      }
    }
    const ok = await showSystemNotification(
      "Call A now",
      {},
      {
        Notification: N,
        serviceWorker: {
          getRegistration: async () => ({
            showNotification: async (t: string) => void shown.push(t),
          }),
        },
      },
    );
    expect(ok).toBe(true);
    expect(shown).toEqual(["Call A now"]);
  });
  it("reports false, without throwing, when nothing can show it", async () => {
    class N {
      constructor() {
        throw new TypeError("Illegal constructor");
      }
    }
    expect(await showSystemNotification("x", {}, { Notification: N })).toBe(false);
    expect(await showSystemNotification("x", {}, {})).toBe(false);
  });
});

describe("frontend-ui-11: Escape in a popover stays in the popover", () => {
  function press(target: EventTarget, key: string) {
    const e = Object.assign(new Event("keydown", { cancelable: true }), { key });
    const stop = vi.spyOn(e, "stopPropagation");
    target.dispatchEvent(e);
    return { stopped: stop.mock.calls.length > 0, prevented: e.defaultPrevented };
  }
  it("handles Escape first, and keeps it from the dialog around it", () => {
    const target = new EventTarget() as unknown as Document;
    const closed = vi.fn();
    const off = listenEscape(target, closed);
    const r = press(target, "Escape");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ stopped: true, prevented: true });
    off();
    press(target, "Escape");
    expect(closed).toHaveBeenCalledTimes(1);
  });
  it("ignores other keys", () => {
    const target = new EventTarget() as unknown as Document;
    const closed = vi.fn();
    listenEscape(target, closed);
    expect(press(target, "Enter")).toEqual({ stopped: false, prevented: false });
    expect(closed).not.toHaveBeenCalled();
  });
});

describe("frontend-ui-12: theme radios move with the arrow keys", () => {
  it("steps and wraps", () => {
    expect(nextTheme("light", "ArrowRight")).toBe("dark");
    expect(nextTheme("system", "ArrowRight")).toBe("light");
    expect(nextTheme("light", "ArrowLeft")).toBe("system");
    expect(nextTheme("dark", "ArrowDown")).toBe("system");
    expect(nextTheme("dark", "ArrowUp")).toBe("light");
  });
  it("ignores other keys", () => {
    expect(nextTheme("dark", "Tab")).toBeNull();
  });
});

describe("frontend-ui-13: the Call toast only says copied when it was", () => {
  it("says copied on success", () => {
    expect(callToast("+13055550121", true)).toMatch(/copied\. Paste/);
  });
  it("gives the number and no false claim when the clipboard refused", () => {
    const msg = callToast("+13055550121", false);
    expect(msg).toContain("+13055550121");
    expect(msg).not.toMatch(/^\+13055550121 copied/);
  });
});
