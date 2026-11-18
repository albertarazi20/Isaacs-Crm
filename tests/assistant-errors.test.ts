import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { apiErrorWords } from "@/lib/assistant/errors";

const bad = (status: number, message: string) =>
  Anthropic.APIError.generate(
    status,
    { error: { type: "invalid_request_error", message } },
    message,
    new Headers(),
  );

describe("apiErrorWords", () => {
  it("says plainly when the Anthropic account has no credit", () => {
    const words = apiErrorWords(
      bad(
        400,
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.",
      ),
    );
    expect(words).toContain("out of credit");
    expect(words).toContain("Plans & Billing");
  });

  it("keeps the other messages", () => {
    expect(apiErrorWords(bad(401, "invalid x-api-key"))).toContain("key was refused");
    expect(apiErrorWords(bad(429, "slow down"))).toContain("busy");
    expect(apiErrorWords(bad(400, "something else"))).toBe(
      "The assistant ran into a problem. Try again.",
    );
  });
});
