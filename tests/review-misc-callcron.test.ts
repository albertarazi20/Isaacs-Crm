import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callCron } from "../netlify/lib/callCron";

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  vi.stubEnv("APP_URL", "https://crm.example.com/");
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("callCron", () => {
  it("passes 200 and 207", async () => {
    vi.stubGlobal("fetch", reply(200, {}));
    await expect(callCron("outbox")).resolves.toBeUndefined();
    vi.stubGlobal("fetch", reply(207, {}));
    await expect(callCron("inbox")).resolves.toBeUndefined();
  });
  it("lets the documented 'not configured' 503 pass without failing the run", async () => {
    vi.stubGlobal("fetch", reply(503, { error: "RESEND_API_KEY / RESEND_FROM not configured" }));
    await expect(callCron("reminders")).resolves.toBeUndefined();
  });
  it("still fails on 401, 500, 502 and any other 503", async () => {
    for (const [status, body] of [
      [401, { error: "unauthorized" }],
      [500, { error: "boom" }],
      [502, { error: "some reminder emails failed to send" }],
      [503, { error: "database unavailable" }],
      [503, "<html>gateway</html>"],
    ] as const) {
      vi.stubGlobal("fetch", reply(status, body));
      await expect(callCron("reminders")).rejects.toThrow(`cron reminders: ${status}`);
    }
  });
});
