import { describe, expect, it } from "vitest";
import { authResults, senderVerified } from "@/lib/inbox/gmailRead";

const verified = (header: string | null, from: string) => senderVerified(authResults(header, from));

describe("sender verification follows the DMARC rule: one aligned pass is enough", () => {
  it("accepts SPF aligned with the DKIM signed by a provider's domain", () => {
    expect(
      verified(
        "mx.google.com; dkim=pass header.i=@mailer.net header.s=s1; spf=pass (google.com: domain of bounce@pizza.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@pizza.com; dmarc=pass header.from=pizza.com",
        "mike@pizza.com",
      ),
    ).toBe(true);
  });
  it("accepts DKIM aligned with the From domain when SPF passes for a third-party bounce domain", () => {
    expect(
      verified(
        "mx.google.com; dkim=pass header.i=@pizza.com header.s=resend; spf=pass smtp.mailfrom=send.mailer.net; dmarc=pass header.from=pizza.com",
        "Mike <mike@pizza.com>",
      ),
    ).toBe(true);
  });
  it("accepts an aligned SPF when DKIM is absent", () => {
    expect(
      verified("mx.google.com; spf=pass smtp.mailfrom=mike@pizza.com; dkim=none", "mike@pizza.com"),
    ).toBe(true);
  });
  it("rejects spoofed mail: passes that are for someone else's domain", () => {
    expect(
      verified(
        "mx.google.com; dkim=pass header.d=attacker.com; spf=pass smtp.mailfrom=bounce@attacker.com",
        "mike@pizza.com",
      ),
    ).toBe(false);
  });
  it("rejects an aligned domain that failed, and a bare pass that names no domain", () => {
    expect(
      verified("mx.google.com; spf=fail smtp.mailfrom=mike@pizza.com; dkim=none", "mike@pizza.com"),
    ).toBe(false);
    expect(verified("mx.google.com; spf=pass; dkim=pass", "mike@pizza.com")).toBe(false);
    expect(verified(null, "mike@pizza.com")).toBe(false);
  });
});
