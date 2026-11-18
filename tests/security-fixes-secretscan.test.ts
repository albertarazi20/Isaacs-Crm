import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isPlaceholderValue,
  passwordOfUrl,
  redact,
  redactUrl,
  scanText,
  secretAllowed,
} from "../scripts/lib/secretScan.mjs";

// More rules for `pnpm security`. Every "secret" here is assembled at run time from pieces so none of them sits in the
// repository as a literal the scan would flag.

const rules = (text: string) => scanText(text).map((f) => f.rule);
const PW = ["Zk3Qm9", "xT1vB7nL", "p4RcW8"].join("");
const TAIL24 = "q83xK2m9ZpL0vB7tYc4RnW1e";
const TAIL36 = "Zk3Qm9xT1vB7nLp4RcW8yHs2Ud5Ae0GfXr6T";

describe("new vendor and URL rules catch what they should", () => {
  it.each([
    [
      "postgres:// with user and password",
      `url: "postgres://app:${PW}@db.example.org:5432/crm"`,
      "database-url-credentials",
    ],
    [
      "postgresql:// with user and password",
      `DATABASE_URL=postgresql://app:${PW}@db.example.org/crm`,
      "database-url-credentials",
    ],
    [
      "a pooler URL with a dotted user",
      `postgres://postgres.abcdefgh:${PW}@aws-0-us-east-1.pooler.example.com:6543/postgres`,
      "database-url-credentials",
    ],
    [
      "a Resend key",
      `RESEND_API_KEY=${["re", "_", "AbCd1234", "_", TAIL24].join("")}`,
      "resend-key",
    ],
    ["a GitHub personal token", `token: ${["gh", "p_", TAIL36].join("")}`, "github-token"],
    ["a GitHub OAuth token", `const t = '${["gh", "o_", TAIL36].join("")}'`, "github-token"],
    [
      "a GitHub fine-grained token",
      `${["github", "_pat_", "11ABCDEFG0", "_", TAIL36].join("")}`,
      "github-token",
    ],
    ["a Netlify token", `NETLIFY_AUTH_TOKEN=${["nf", "p_", TAIL24].join("")}`, "netlify-token"],
    [
      "a Stripe live secret key",
      `stripe(${JSON.stringify(["sk", "_live_", TAIL24].join(""))})`,
      "stripe-live-key",
    ],
    [
      "a Stripe live restricted key",
      `key = ${["rk", "_live_", TAIL24].join("")}`,
      "stripe-live-key",
    ],
  ])("%s", (_n, text, rule) => {
    expect(rules(text)).toEqual([rule]);
  });

  it("never carries the secret in the finding, even a short one", () => {
    const [f] = scanText(`postgres://app:${PW}@db.example.org/crm`);
    expect(f?.preview).not.toContain(PW);
    expect(f?.preview).toBe(`post... [${f?.value.length} chars]`);
  });
});

describe("assignments to the app's own secrets: any literal is a finding unless it is a stand-in", () => {
  it.each([
    ["ACCESS_PASSCODE in an env file", "ACCESS_PASSCODE=hunter2"],
    ["a weak SESSION_SECRET", 'SESSION_SECRET="abc"'],
    ["DATABASE_URL pointing at a remote host", "DATABASE_URL=postgres://db.internal.corp:5432/crm"],
    ["ANTHROPIC_API_KEY with an odd value", "ANTHROPIC_API_KEY=my-key-value"],
    ["SUPABASE_SERVICE_KEY in YAML", "SUPABASE_SERVICE_KEY: abcdef123"],
    ["a quoted JSON key", '"ACCESS_PASSCODE": "open sesame"'],
    ["an assignment in code", 'process.env.SESSION_SECRET = "s".repeat(40);'],
    ["a quoted value in an object", 'const env = { SESSION_SECRET: "short" };'],
    ["export in a shell script", "export ACCESS_PASSCODE=letmein1"],
    ["a markdown list item", "- ACCESS_PASSCODE=letmein1"],
    ["a single-quoted value", "SESSION_SECRET='a b c'"],
    ["a backtick value", "SESSION_SECRET: `literal`"],
    ["with spaces around the equals sign", "ACCESS_PASSCODE = hunter2"],
  ])("%s", (_n, text) => {
    expect(rules(text)).toEqual(["named-secret-assignment"]);
  });

  it("shows no characters of a short value, only its length", () => {
    const [f] = scanText("ACCESS_PASSCODE=hunter2");
    expect(f?.preview).toBe("[7 chars]");
    expect(redact("a".repeat(15))).toBe("[15 chars]");
    expect(redact("a".repeat(16))).toBe(`aaaa... [16 chars]`);
  });

  it.each([
    ["empty", "SESSION_SECRET="],
    ["empty quotes", 'SESSION_SECRET=""'],
    ["changeme", "ACCESS_PASSCODE=changeme"],
    ["change-me style", "SESSION_SECRET=change-me-to-a-long-random-string"],
    ["a your-... marker", "ACCESS_PASSCODE=your-passcode-here"],
    ["a placeholder in angle brackets", "SESSION_SECRET=<a long random string>"],
    ["a bracketed marker", "DATABASE_URL=[YOUR-CONNECTION-STRING]"],
    ["a mask", "ANTHROPIC_API_KEY=********"],
    ["an elided URL", "DATABASE_URL=postgres://…"],
    ["a shell reference", "SESSION_SECRET=$SESSION_SECRET"],
    ["a braced reference", "DATABASE_URL=${DB_URL}"],
    ["a quoted braced reference", 'SESSION_SECRET: "${{ secrets.SESSION_SECRET }}"'],
    ["a template literal with a reference", "const v = `SESSION_SECRET=${secret}`;"],
    ["a process.env read assigned on", "SESSION_SECRET=process.env.SESSION_SECRET"],
    ["a read in code", "const s = process.env.SESSION_SECRET;"],
    ["a comparison", 'if (process.env.ACCESS_PASSCODE === "x") {}'],
    ["a type annotation", "  ACCESS_PASSCODE: string;"],
    ["an optional field's type", "  SESSION_SECRET?: string;"],
    ["a zod schema", "  SESSION_SECRET: z.string().min(32),"],
    ["a code assignment from a variable", "const x = { SESSION_SECRET: secret };"],
    ["an arrow function", "const f = (ACCESS_PASSCODE) => 1;"],
    ["prose with the name and no value", "Set ACCESS_PASSCODE in the environment."],
    ["the name inside a longer name", "MY_SESSION_SECRET_NAME=abc"],
    [
      "a local database with no password",
      "DATABASE_URL=postgres://postgres@localhost:5433/postgres",
    ],
    ["a local database with no user", "DATABASE_URL=postgresql://localhost/crm"],
    ["a placeholder database password", "DATABASE_URL=postgres://user:password@db.example.org/crm"],
    ["the word password as the value", "ACCESS_PASSCODE=password"],
  ])("%s is left alone", (_n, text) => {
    expect(scanText(text)).toEqual([]);
  });

  it("reports a long random value once, under the more specific rule", () => {
    expect(rules(`SESSION_SECRET=${"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b"}`)).toEqual([
      "secret-assignment",
    ]);
    expect(rules(`ANTHROPIC_API_KEY=${["sk-ant-", "api03-", TAIL24].join("")}`)).toEqual([
      "anthropic-key",
    ]);
  });
});

describe("the new vendor rules do not fire on look-alikes", () => {
  it.each([
    ["a snake_case identifier starting re_", "const re_authenticate_after_login_check = 1;"],
    ["an identifier that ends in re_", "pre_send_validation_of_everything_ok1"],
    ["a short re_ word", "re_send_1"],
    ["a gh word that is not a token", "ghp_short"],
    ["nfp_ with too little after it", "nfp_abc"],
    ["a publishable Stripe key", `${["pk", "_live_", TAIL24].join("")}`],
    ["a Stripe test key", `${["sk", "_test_", TAIL24].join("")}`],
    ["a database URL with no password", "postgres://postgres@localhost:5433/postgres"],
    ["a database URL with a template password", "postgres://app:${DB_PASSWORD}@db.example.org/crm"],
    ["a database URL with the word password", "postgres://user:password@host/db"],
    ["a database URL with a masked password", "postgresql://app:****@db.example.org/crm"],
    ["an http URL (not a database)", "https://user:pw@example.com/path"],
  ])("%s", (_n, text) => {
    expect(scanText(text)).toEqual([]);
  });

  it("isPlaceholderValue and passwordOfUrl agree on the edge cases", () => {
    for (const v of [
      "",
      " ",
      "x",
      "xxx",
      "***",
      "...",
      "<pw>",
      "[pw]",
      "$VAR",
      "${VAR}",
      "pass",
      "dummy1",
      "your-key",
    ])
      expect(isPlaceholderValue(v), v).toBe(true);
    for (const v of ["hunter2", "s", "abc", "S3cret!x"])
      expect(isPlaceholderValue(v), v).toBe(false);
    expect(passwordOfUrl("postgres://u:pw@h/db")).toBe("pw");
    expect(passwordOfUrl("postgres://u@h/db")).toBe("");
    expect(passwordOfUrl("postgres://h/db")).toBe("");
  });
});

describe("the allowlist can cover a new finding, with a narrow match", () => {
  it("a named-secret entry is matched by path and rule, not by any other path", () => {
    const [f] = scanText('process.env.SESSION_SECRET = "s".repeat(40);');
    if (!f) throw new Error("expected a finding");
    const entry = { path: "tests/a.test.ts", rule: "named-secret-assignment", reason: "fake" };
    expect(secretAllowed(entry, "tests/a.test.ts", f)).toBe(true);
    expect(secretAllowed(entry, "src/a.ts", f)).toBe(false);
    expect(secretAllowed({ ...entry, rule: "jwt" }, "tests/a.test.ts", f)).toBe(false);
  });
});

describe("the http:// finding never prints credentials or a query string", () => {
  it.each([
    ["http://user:pw@example.com/a/b", "http://***@example.com/a/b"],
    ["http://user@example.com/a", "http://***@example.com/a"],
    ["http://example.com/hook?token=abc123&x=1", "http://example.com/hook?..."],
    ["http://example.com/a#frag", "http://example.com/a#..."],
    ["http://user:pw@example.com/a?key=abc#f", "http://***@example.com/a?..."],
    ["http://example.com/plain", "http://example.com/plain"],
  ])("%s", (input, shown) => {
    expect(redactUrl(input)).toBe(shown);
  });

  it("the scan script prints findings through it", () => {
    const src = readFileSync("scripts/security-scan.mjs", "utf8");
    expect(src).toContain("redactUrl(h.url)");
    expect(src).not.toMatch(/\$\{h\.url\}/);
  });
});
