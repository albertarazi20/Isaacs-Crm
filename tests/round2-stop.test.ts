import { describe, expect, it } from "vitest";
import { isStopMessage } from "@/lib/messaging/stop";

const SUBJECT = "Re: Your statements";

describe("stop detection: a message that IS an opt-out", () => {
  it.each([
    "STOP",
    "Stop",
    "stop.",
    "STOPALL",
    "Stop all",
    "UNSUBSCRIBE",
    "unsubscribe me",
    "CANCEL",
    "END",
    "QUIT",
    "opt out",
    "Opt-out",
    "Stop emailing me",
    "please stop emailing me!",
    "Stop texting me",
    "Stop contacting us.",
    "Stop these emails",
    "stop sending me emails",
    "Remove me",
    "Remove me from your list",
    "please remove me from your mailing list, thanks",
    "Take me off your list",
    "take us off this list",
    "Do not email me",
    "Don't email me again",
    "dont contact me anymore",
    "no more emails",
    "Leave me alone",
    "Not interested",
    "not interested, thanks",
    "Hi John, please stop",
    "Hello, remove me from this list. Thank you",
    "Stop, don't email me again",
    "Please stop emailing me. I already have funding.",
    "STOP\n\nOn Mon, Nov 10, 2026 at 9:02 AM Josh <josh@selectivecap.com> wrote:\n> Hi Mike,\n> To stop these emails: https://x/u/abc",
    "Stop On Mon, Nov 10, 2026 at 9:02 AM Josh <josh@selectivecap.com> wrote: > Hi Mike, > To stop these emails: https://x/u/abc",
    "Unsubscribe\n--\nSent from my iPhone",
    // round 4: replies a stricter reader missed
    "Stop\n\nSent from my iPhone",
    "Stop\n\nSent from my Samsung Galaxy smartphone",
    "STOP\nGet Outlook for iOS",
    "Stop\nMike Johnson",
    "Stop\n\nMike Johnson\nOwner, Pizza Palace\n305-555-0100",
    "I'm not interested, please stop",
    "This is spam, stop",
    "I told you already to stop",
    "I told you to stop emailing me",
    "Stop contacting me or I will report you",
    "You've emailed me 5 times. Stop.",
    "Please don't send me anything else",
    "Leave us alone",
    "Opt me out",
    "I want to unsubscribe",
    "I'd like to be removed from your list",
    "Unsubscribed",
    "Remove",
    "no longer interested",
    "We are no longer interested.",
    "I am not interested",
    "Cease and desist",
    "Please cease contact immediately",
    "Do not send me any more emails",
    "Stop emailing me because I'm busy",
  ])("%j is an opt-out", (text) => {
    expect(isStopMessage(SUBJECT, text)).toBe(true);
  });

  it("reads the subject only when there is no body of their own", () => {
    expect(isStopMessage("Unsubscribe", "")).toBe(true);
    expect(isStopMessage("Re: STOP", "")).toBe(true);
    expect(isStopMessage("Re: Fwd: unsubscribe", "> quoted only")).toBe(true);
    expect(isStopMessage("Unsubscribe", "Sending October tonight, thanks")).toBe(false);
    expect(isStopMessage("Re: Your statements", "")).toBe(false);
  });
});

describe("stop detection: a conversation that only mentions the word", () => {
  it.each([
    "Can you stop by tomorrow?",
    "Please stop by the shop at 3",
    "Stop by whenever you like",
    "We had to stop the second truck for repairs.",
    "I'll send October over tomorrow once the bank posts it.",
    "Don't stop calling, just not in the morning",
    "the bus stop is out front",
    "Can you cancel the 3pm call and move it to Friday?",
    "I want to end the lease early, can we talk about funding?",
    "Please remove the late fee from my statement",
    "Remember to unsubscribe from nothing, just send me the offer",
    "Stop, call me at 305-555-0100",
    "We are not interested in a factor rate above 1.3 but send the terms",
    "Do not email the contract, fax it",
    // round 4: the wider net must still leave conversations alone
    "We can't stop now, call me",
    "don't stop the deal",
    "Please don't send me the contract by mail, fax it",
    "I asked you to stop by the shop",
    "Stop\n\nCall me at 305-555-0100",
    "We are not interested in a factor rate above 1.3 but send the terms",
    "I want to end the lease early",
    "Leave the paperwork with my wife",
    "Thanks!",
    "",
  ])("%j is not an opt-out", (text) => {
    expect(isStopMessage(SUBJECT, text)).toBe(false);
  });

  it("a long message that mentions stop in passing is not an opt-out", () => {
    const long = `${"Stop emailing me. ".repeat(30)}`;
    expect(long.length).toBeGreaterThan(300);
    expect(isStopMessage(SUBJECT, long)).toBe(false);
  });

  it("our own quoted footer never counts", () => {
    expect(isStopMessage("Re: hi", "> To stop these emails: https://x/u/abc")).toBe(false);
    expect(
      isStopMessage("Re: hi", "Thanks, will do\n> To stop these emails: https://x/u/abc"),
    ).toBe(false);
  });
});
