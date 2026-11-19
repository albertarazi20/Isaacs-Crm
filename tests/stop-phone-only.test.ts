import { describe, expect, it } from "vitest";
import { isStopMessage } from "@/lib/messaging/stop";

const SUBJECT = "Re: Your statements";

/**
 * "Don't call" is a request about the phone. When the same message invites email or writing, the lead is alive: an
 * email opt-out is permanent (a stop_reply suppression), so it must not be created from it. Real STOPs keep working.
 */
describe("stop detection: phone-only refusals that invite email", () => {
  it.each([
    "Please don't call me, email me instead",
    "Don't call, just email me the numbers",
    "Do not call me. Email is better, I'm on job sites all day",
    "Stop calling me, you can write me at this address",
    "Never call me again, send me an email with the offer",
    "Don't text me, e-mail me the details",
    "Please do not call. Reach me by email.",
  ])("is a conversation, not an opt-out: %s", (body) => {
    expect(isStopMessage(SUBJECT, body)).toBe(false);
  });

  it.each([
    "Don't email me",
    "Please don't call me or email me again",
    "Stop calling me. Stop emailing me.",
    "Don't call me, remove me from your list",
    "Don't call me. Unsubscribe.",
    "STOP",
    "Do not contact me again",
    "Don't call me again",
    "Stop texting me",
    // a complaint that mentions email is an opt-out, not an invitation to write
    "Do not call me. I do not want your emails",
    "Stop calling me. I get too many emails.",
    "Stop calling me, you're spamming my email",
    "stop calling me, I never read email",
    "stop texting me, write to my attorney",
  ])("is still an opt-out: %s", (body) => {
    expect(isStopMessage(SUBJECT, body)).toBe(true);
  });
});
