import { describe, expect, it } from "vitest";
import { authResults, htmlToText, parseAddress, splitMessageIds } from "@/lib/inbox/gmailRead";

describe("reading a Gmail message", () => {
  it("reads the SPF and DKIM verdicts out of Authentication-Results", () => {
    expect(authResults("mx.google.com; spf=pass smtp.mailfrom=x; dkim=pass header.i=@x")).toEqual({
      spf: true,
      dkim: true,
    });
    expect(authResults("mx.google.com; spf=softfail; dkim=none")).toEqual({
      spf: false,
      dkim: false,
    });
    expect(authResults(null)).toEqual({ spf: null, dkim: null });
  });
  it("helpers: addresses, message ids, html", () => {
    expect(parseAddress('"Jane Doe" <jane@x.com>')).toEqual({
      name: "Jane Doe",
      address: "jane@x.com",
    });
    expect(splitMessageIds("<a@x> <b@y>")).toEqual(["<a@x>", "<b@y>"]);
    expect(htmlToText("<p>Approved <b>$45,000</b></p><br>at 1.35")).toBe(
      "Approved $45,000\n\nat 1.35",
    );
  });
});
