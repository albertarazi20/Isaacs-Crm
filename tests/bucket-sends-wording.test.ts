import { describe, expect, it } from "vitest";
import { bucketSends } from "@/lib/buckets/wording";

const b = (over: Partial<Parameters<typeof bucketSends>[0]> = {}) => ({
  email_steps: 0,
  call_steps: 0,
  daily_template_id: null,
  daily_reminder_minute: 600,
  ...over,
});

describe("what a bucket card says it will send", () => {
  it("counts real emails and call tasks, not every step", () => {
    // Interested: email, email, call, email, move to Cold
    expect(bucketSends(b({ email_steps: 3, call_steps: 1 }))).toBe(
      "First email on submit, then 2 more emails and a call task",
    );
    expect(bucketSends(b({ email_steps: 2, call_steps: 0 }))).toBe(
      "First email on submit, then 1 more email",
    );
    expect(bucketSends(b({ email_steps: 3, call_steps: 2 }))).toBe(
      "First email on submit, then 2 more emails and 2 call tasks",
    );
  });
  it("handles the plain cases", () => {
    expect(bucketSends(b())).toBe("No emails set up yet");
    expect(bucketSends(b({ call_steps: 1 }))).toBe("No emails: a call task for you");
    expect(bucketSends(b({ email_steps: 1 }))).toBe("One email on submit");
    expect(bucketSends(b({ email_steps: 1, call_steps: 1 }))).toBe(
      "First email on submit, then a call task",
    );
  });
  it("a daily bucket says the daily reminder and the shop's time", () => {
    expect(
      bucketSends(b({ email_steps: 4, daily_template_id: "t", daily_reminder_minute: 600 })),
    ).toBe("One email every day but Saturday at 10:00 AM, their time");
    expect(bucketSends(b({ daily_template_id: "t", daily_reminder_minute: 810 }))).toBe(
      "One email every day but Saturday at 1:30 PM, their time",
    );
  });
});
