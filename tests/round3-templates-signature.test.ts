import { describe, expect, it } from "vitest";
import { emailLeftoverText, leftoverFields } from "@/lib/messaging/merge";

describe("the email send check covers the signature", () => {
  it("a signature that still holds {tokens} blocks the send", () => {
    const text = emailLeftoverText("Hi", "All good here", "Thanks,\n{sendr}");
    expect(leftoverFields(text)).toEqual(["{sendr}"]);
  });

  it("a clean subject, body and signature leave nothing", () => {
    expect(leftoverFields(emailLeftoverText("Hi", "Body", "Thanks,\nIsaac"))).toEqual([]);
  });

  it("body and subject leftovers are still reported alongside", () => {
    const text = emailLeftoverText("Re {business}", "Link: {upload_link}", "{x}");
    expect(leftoverFields(text)).toEqual(["{business}", "{upload_link}", "{x}"]);
  });
});
