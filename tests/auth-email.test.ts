import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  buildAuthUrl,
  exchangeCode,
  GMAIL_SEND_SCOPE,
  isAllowedEmail,
  signOAuthState,
  verifyOAuthState,
} from "@/lib/auth/google";
import { signSession, verifySession } from "@/lib/auth/session";
import { accessTokenFor, GmailReconnectError, sendViaGmail } from "@/lib/email/gmail";
import { sendViaResend } from "@/lib/email/resend";

const KEY = randomBytes(32).toString("base64");
const SECRET = "s".repeat(40);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("secret encryption", () => {
  it("round-trips and never repeats a ciphertext", () => {
    const a = encryptSecret("1//refresh-token", KEY);
    const b = encryptSecret("1//refresh-token", KEY);
    expect(a).not.toBe(b);
    expect(a).not.toContain("refresh-token");
    expect(decryptSecret(a, KEY)).toBe("1//refresh-token");
  });
  it("rejects tampering, the wrong key and a bad key", () => {
    const blob = encryptSecret("secret", KEY);
    const [v, iv, tag, ct] = blob.split(".");
    expect(() => decryptSecret([v, iv, tag, `${ct?.slice(0, -2)}AA`].join("."), KEY)).toThrow();
    expect(() => decryptSecret(blob, randomBytes(32).toString("base64"))).toThrow();
    expect(() => encryptSecret("x", "c2hvcnQ=")).toThrow(/32 bytes/);
    expect(() => encryptSecret("x", undefined)).toThrow(/not set/);
    expect(() => decryptSecret("garbage", KEY)).toThrow(/format/);
  });
});

describe("session token", () => {
  it("round-trips the user", async () => {
    const token = await signSession({ userId: "u1", email: "a@x.com" }, SECRET);
    expect(await verifySession(token, SECRET)).toEqual({
      userId: "u1",
      email: "a@x.com",
      epoch: 0,
    });
  });
  it("rejects a wrong secret, a tampered token, an expired token and no token", async () => {
    const token = await signSession({ userId: "u1", email: "a@x.com" }, SECRET);
    expect(await verifySession(token, "t".repeat(40))).toBeNull();
    expect(await verifySession(`${token.slice(0, -3)}abc`, SECRET)).toBeNull();
    const old = await signSession(
      { userId: "u1", email: "a@x.com" },
      SECRET,
      new Date(Date.now() - 40 * 86_400_000),
    );
    expect(await verifySession(old, SECRET)).toBeNull();
    expect(await verifySession(undefined, SECRET)).toBeNull();
    expect(await verifySession("a.b.c", SECRET)).toBeNull();
  });
  it("refuses an unsigned alg=none token", async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const forged = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "u1", email: "a@x.com", exp: 9_999_999_999 })}.`;
    expect(await verifySession(forged, SECRET)).toBeNull();
  });
});

describe("Google OAuth", () => {
  const base = { clientId: "cid", redirectUri: "https://app.test/api/auth/callback", state: "st" };
  it("asks for basic scopes only on login, so a dead Gmail grant can never lock Isaac out", () => {
    const url = new URL(buildAuthUrl({ ...base, purpose: "login" }));
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("access_type")).toBeNull();
  });
  it("asks for gmail.send, offline access and consent when connecting Gmail", () => {
    const url = new URL(buildAuthUrl({ ...base, purpose: "gmail", loginHint: "isaac@gmail.com" }));
    expect(url.searchParams.get("scope")).toContain(GMAIL_SEND_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("login_hint")).toBe("isaac@gmail.com");
  });
  it("fails closed on an empty allowlist and ignores case and spaces", () => {
    expect(isAllowedEmail("isaac@gmail.com", "")).toBe(false);
    expect(isAllowedEmail("Isaac@Gmail.com", " ronny@x.com , isaac@gmail.com ")).toBe(true);
    expect(isAllowedEmail("evil@gmail.com", "isaac@gmail.com")).toBe(false);
  });
  it("exchanges a code with the right form body, and surfaces failures", async () => {
    const fetchMock = vi.fn(async () => json({ access_token: "a", id_token: "i", scope: "s" }));
    await exchangeCode(
      { code: "c", clientId: "cid", clientSecret: "sec", redirectUri: "r" },
      fetchMock as never,
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(String(init.body)).toContain("grant_type=authorization_code");
    await expect(
      exchangeCode(
        { code: "c", clientId: "cid", clientSecret: "sec", redirectUri: "r" },
        (async () => json({}, 400)) as never,
      ),
    ).rejects.toThrow(/400/);
  });
});

describe("Gmail send", () => {
  const cfg = { clientId: "cid", clientSecret: "sec", tokenEncKey: KEY };
  const creds = () => ({
    refreshTokenEnc: encryptSecret("1//rt", KEY),
    googleEmail: "isaac@gmail.com",
  });
  const msg = { to: "mike@pizza.com", subject: "Checking in", text: "Hi Mike" };

  it("refreshes the token then sends the raw message as Isaac", async () => {
    const calls: [string, RequestInit][] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return url.includes("oauth2")
        ? json({ access_token: "AT" })
        : json({ id: "m1", threadId: "t1" });
    });
    const res = await sendViaGmail(creds(), cfg, msg, fetchMock as never);
    expect(res).toEqual({ id: "m1", threadId: "t1" });
    expect(String(calls[0]?.[1].body)).toContain("refresh_token=1%2F%2Frt");
    expect((calls[1]?.[1].headers as Record<string, string>).authorization).toBe("Bearer AT");
    const raw = (JSON.parse(String(calls[1]?.[1].body)) as { raw: string }).raw;
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("From: isaac@gmail.com");
    expect(mime).toContain("To: mike@pizza.com");
  });
  it("turns invalid_grant into a reconnect prompt", async () => {
    await expect(
      accessTokenFor(creds(), cfg, (async () => json({ error: "invalid_grant" }, 400)) as never),
    ).rejects.toBeInstanceOf(GmailReconnectError);
  });
  it("treats a 401/403 from Gmail as a reconnect, and other failures as plain errors", async () => {
    const mk = (status: number) =>
      (async (url: string) =>
        url.includes("oauth2") ? json({ access_token: "AT" }) : json({}, status)) as never;
    await expect(sendViaGmail(creds(), cfg, msg, mk(403))).rejects.toBeInstanceOf(
      GmailReconnectError,
    );
    await expect(sendViaGmail(creds(), cfg, msg, mk(500))).rejects.not.toBeInstanceOf(
      GmailReconnectError,
    );
  });
  it("says what Google said when a 403 is not a permission problem, instead of looping on reconnect", async () => {
    const mk = (status: number, reason: string, message: string) =>
      (async (url: string) =>
        url.includes("oauth2")
          ? json({ access_token: "AT" })
          : json({ error: { message, errors: [{ reason }] } }, status)) as never;
    const off = mk(403, "accessNotConfigured", "Gmail API has not been used in project 123");
    await expect(sendViaGmail(creds(), cfg, msg, off)).rejects.toThrow(
      /Gmail send failed \(403 accessNotConfigured: Gmail API has not been used in project 123\)/,
    );
    await expect(sendViaGmail(creds(), cfg, msg, off)).rejects.not.toBeInstanceOf(
      GmailReconnectError,
    );
    const quota = mk(403, "rateLimitExceeded", "Rate Limit Exceeded");
    await expect(sendViaGmail(creds(), cfg, msg, quota)).rejects.not.toBeInstanceOf(
      GmailReconnectError,
    );
    // a missing scope IS fixed by signing in again, and so is a plain 401
    const scope = mk(
      403,
      "insufficientPermissions",
      "Request had insufficient authentication scopes.",
    );
    await expect(sendViaGmail(creds(), cfg, msg, scope)).rejects.toBeInstanceOf(
      GmailReconnectError,
    );
    await expect(
      sendViaGmail(creds(), cfg, msg, mk(401, "authError", "Invalid Credentials")),
    ).rejects.toBeInstanceOf(GmailReconnectError);
  });
});

describe("Resend", () => {
  it("posts the digest and returns the message id", async () => {
    const fetchMock = vi.fn(async () => json({ id: "re_1" }));
    const id = await sendViaResend(
      { apiKey: "k", from: "Isaac CRM <crm@x.com>" },
      { to: "i@x.com", subject: "S", text: "t", html: "<p>t</p>" },
      fetchMock as never,
    );
    expect(id).toBe("re_1");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(String(init.body))).toMatchObject({ to: ["i@x.com"], subject: "S" });
  });
  it("throws with the provider's message on failure", async () => {
    await expect(
      sendViaResend(
        { apiKey: "k", from: "f" },
        { to: "i@x.com", subject: "S", text: "t", html: "h" },
        (async () => json({ message: "domain not verified" }, 403)) as never,
      ),
    ).rejects.toThrow(/domain not verified/);
  });
});

describe("OAuth state cookie", () => {
  const secret = "s".repeat(40);
  it("round-trips and cannot be forged or tampered with", () => {
    const c = signOAuthState({ state: "abc", purpose: "gmail" }, secret);
    expect(verifyOAuthState(c, secret)).toEqual({ state: "abc", purpose: "gmail" });
    expect(verifyOAuthState(c, "t".repeat(40))).toBeNull();
    const [body, sig] = c.split(".");
    const forged = Buffer.from(JSON.stringify({ state: "abc", purpose: "login" })).toString(
      "base64url",
    );
    expect(verifyOAuthState(`${forged}.${sig}`, secret)).toBeNull();
    expect(verifyOAuthState(`${body}.`, secret)).toBeNull();
    expect(verifyOAuthState(undefined, secret)).toBeNull();
    expect(verifyOAuthState(JSON.stringify({ state: "abc", purpose: "login" }), secret)).toBeNull(); // the old unsigned form
  });
});
