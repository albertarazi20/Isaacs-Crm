import { describe, expect, it } from "vitest";
import { parseEnv, productionUrlProblem } from "@/lib/env";

const base = {
  DATABASE_URL: "postgres://x",
  SESSION_SECRET: "s".repeat(32),
};

describe("environment", () => {
  it("takes the trailing slash off APP_URL, so the Google redirect URI is not `//api/auth/callback`", () => {
    expect(parseEnv({ ...base, APP_URL: "https://isaac.example.com/" }).APP_URL).toBe(
      "https://isaac.example.com",
    );
    expect(parseEnv({ ...base, APP_URL: " https://isaac.example.com/// " }).APP_URL).toBe(
      "https://isaac.example.com",
    );
  });

  it("treats a blank optional variable as not set instead of taking the whole app down", () => {
    const e = parseEnv({
      ...base,
      CRON_SECRET: "",
      RESEND_API_KEY: "  ",
      RESEND_FROM: "",
      GOOGLE_CLIENT_ID: "",
      TOKEN_ENC_KEY: "",
      APP_URL: "",
    });
    expect(e.CRON_SECRET).toBeUndefined();
    expect(e.RESEND_API_KEY).toBeUndefined();
    expect(e.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(e.APP_URL).toBe("http://localhost:3000");
  });

  it("still rejects a CRON_SECRET that is set but too short, and a SESSION_SECRET that is too short", () => {
    expect(() => parseEnv({ ...base, CRON_SECRET: "short" })).toThrow(/CRON_SECRET/);
    expect(() => parseEnv({ ...base, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });

  it("in production, refuses an unset APP_URL, an http address, and says which variable", () => {
    const prod = { ...base, NODE_ENV: "production" };
    expect(() => parseEnv(prod)).toThrow(/APP_URL: is not set/);
    expect(() => parseEnv({ ...prod, APP_URL: "" })).toThrow(/APP_URL: is not set/);
    expect(() => parseEnv({ ...prod, APP_URL: "http://isaac.example.com" })).toThrow(
      /must start with https/,
    );
    expect(parseEnv({ ...prod, APP_URL: "https://isaac.example.com/" }).APP_URL).toBe(
      "https://isaac.example.com",
    );
  });

  it("a production build run on this machine may use http://localhost, and other modes are untouched", () => {
    expect(
      parseEnv({ ...base, NODE_ENV: "production", APP_URL: "http://localhost:3101" }).APP_URL,
    ).toBe("http://localhost:3101");
    expect(parseEnv({ ...base, NODE_ENV: "development" }).APP_URL).toBe("http://localhost:3000");
    expect(productionUrlProblem("https://a.example.com", "https://a.example.com")).toBeNull();
  });
});
