import { describe, expect, it } from "vitest";
import {
  entropy,
  findHttpUrls,
  httpAllowed,
  isBackupFile,
  isForbiddenEnvFile,
  jwtRole,
  looksRandom,
  parseAllowlist,
  redact,
  scanText,
  secretAllowed,
  summariseAudit,
} from "../scripts/lib/secretScan.mjs";

// Table-driven tests for the pattern matching behind `pnpm security` (scripts/security-scan.mjs). Every "secret" below
// is assembled here at run time from pieces, so none of them sits in the repository as a literal the scan would flag.

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: Record<string, unknown>) =>
  `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`;

const ANTHROPIC = ["sk-ant-", "api03-", "Zk3Qm9xT1vB7nLp4RcW8yHs2Ud5Ae0Gf"].join("");
const AWS = ["AKIA", "Z7Q2M9X4TB6LP3WR"].join("");
const AWS_TEMP = ["ASIA", "Q4W8E2R6T0Y3U7I9"].join("");
const HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";
const B64 = "q83xK2m9ZpL0vB7tYc4RnW1eHdJs6UaFgOiT5yXw8bE=";
const URLSAFE = "Zk3Qm9xT1vB7nLp4RcW8yHs2Ud5Ae0Gf-Xr_Ti6";
const PEM = (kind: string) =>
  `-----${["BEGIN", kind, "PRIVATE KEY"].filter(Boolean).join(" ")}-----`;

const rules = (text: string) => scanText(text).map((f) => f.rule);

describe("real-looking secrets are caught", () => {
  it.each([
    ["an Anthropic key", `const key = "${ANTHROPIC}";`, "anthropic-key"],
    ["an Anthropic key in an env file", `ANTHROPIC_API_KEY=${ANTHROPIC}`, "anthropic-key"],
    ["an AWS access key id", `aws_access_key_id = ${AWS}`, "aws-access-key"],
    ["an AWS temporary key id", `"AccessKeyId": "${AWS_TEMP}"`, "aws-access-key"],
    ["an RSA private key block", PEM("RSA"), "private-key-block"],
    ["an EC private key block", PEM("EC"), "private-key-block"],
    ["an OpenSSH private key block", PEM("OPENSSH"), "private-key-block"],
    ["a plain PKCS8 private key block", PEM(""), "private-key-block"],
    ["a JWT", `Authorization: Bearer ${jwt({ sub: "1234567890", name: "A Person" })}`, "jwt"],
    ["a Supabase anon JWT (still a JWT)", `const anon = '${jwt({ role: "anon" })}'`, "jwt"],
    [
      "a Supabase service_role JWT",
      `SUPABASE_SERVICE_KEY=${jwt({ iss: "supabase", role: "service_role" })}`,
      "supabase-service-key",
    ],
    [
      "a Supabase secret key",
      `key: "${["sb_", "secret_", "Zk3Qm9xT1vB7nLp4RcW8yHs2"].join("")}"`,
      "supabase-service-key",
    ],
    ["a long hex value on a KEY name", `API_KEY=${HEX}`, "secret-assignment"],
    ["a long hex value on a SECRET name (json)", `"SESSION_SECRET": "${HEX}"`, "secret-assignment"],
    ["a base64 value on a TOKEN name", `TOKEN_ENC_KEY: '${B64}'`, "secret-assignment"],
    [
      "a base64url value on a PASSWORD name",
      `const dbPassword = "${URLSAFE}";`,
      "secret-assignment",
    ],
    ["a value after := on a SECRET name", `CRON_SECRET := ${HEX}`, "secret-assignment"],
    ["a lower-case token name", `access_token = "${B64}"`, "secret-assignment"],
  ])("%s", (_name, text, rule) => {
    expect(rules(text)).toEqual([rule]);
  });

  it("reports the line number and never the value", () => {
    const [f] = scanText(`line one\nline two\nconst k = "${ANTHROPIC}";\n`);
    expect(f?.line).toBe(3);
    expect(f?.preview).not.toContain(ANTHROPIC);
    expect(f?.preview).toBe(`sk-a... [${ANTHROPIC.length} chars]`);
    expect(redact(HEX)).toBe(`9f86... [${HEX.length} chars]`);
  });

  it("finds several on several lines, one finding per secret", () => {
    const found = scanText(`a = "${ANTHROPIC}"\nb = ${AWS}\nAPI_KEY=${HEX}\n`);
    expect(found.map((f) => [f.line, f.rule])).toEqual([
      [1, "anthropic-key"],
      [2, "aws-access-key"],
      [3, "secret-assignment"],
    ]);
  });

  it("reports a key once even when two rules match it", () => {
    // the JWT is a jwt AND sits on a KEY name with a long value: one finding, the most specific rule
    const text = `SERVICE_KEY=${jwt({ role: "service_role" })}`;
    expect(rules(text)).toEqual(["supabase-service-key"]);
  });
});

describe("harmless strings are not", () => {
  it.each([
    ["an env lookup", "const s = process.env.CRON_SECRET;"],
    ["a short value", 'const API_KEY = "abc123";'],
    [
      "the stub key in a comment",
      "ANTHROPIC_API_KEY=sk-ant-stub ANTHROPIC_BASE_URL=http://127.0.0.1:4019",
    ],
    [
      "a repeated character on a name that is not one of the app's own",
      `SESSION_SIGNING_KEY: "${"s".repeat(40)}"`,
    ],
    ["a repeated pattern", `API_KEY=${"ab12".repeat(10)}`],
    ["a placeholder", "API_KEY=your-api-key-goes-here-1234567890abcdef"],
    ["an example value", `SECRET=example${HEX}`],
    ["a name with no secret in it", `const checksum = "${HEX}";`],
    ["a uuid on a token name", 'upload_token: "550e8400-e29b-41d4-a716-446655440000"'],
    ["a constant that holds a name", 'const TOKEN_COOKIE_NAME = "isaac_session_token_cookie_v2";'],
    ["a path on a KEY name", 'const STORAGE_KEY = "documents/uploads/merchants/2026/file1";'],
    [
      "a sha512 integrity string",
      "integrity: sha512-V7Qr52IhZmdKPVr+Vtw8o+WLsQJYCTd8loIfpDaMRWGUZfBOYEJeyJIkqGIDMZPwPx24pUMfwSxxI8phr/MbOA==",
    ],
    [
      "a url that merely mentions a key",
      "https://example.com/docs/api-keys/create-a-new-secret-key-today",
    ],
    [
      "prose about tokens",
      "Each upload token is checked before the page opens and expires after 30 days.",
    ],
    ["a JWT-shaped word that is not one", "eyJhbGci.too.short"],
    ["an empty string", ""],
    ["the word PRIVATE KEY without a block", "Never commit a PRIVATE KEY to git."],
  ])("%s", (_name, text) => {
    expect(scanText(text)).toEqual([]);
  });

  it("looksRandom and entropy agree on the edge cases", () => {
    expect(entropy("")).toBe(0);
    expect(entropy("aaaaaaaa")).toBe(0);
    expect(entropy("abcdefgh")).toBeCloseTo(3, 5);
    expect(looksRandom(HEX)).toBe(true);
    expect(looksRandom(B64)).toBe(true);
    expect(looksRandom("a".repeat(40))).toBe(false);
    expect(looksRandom("onlyletterswithnodigitsatallinthisvalue")).toBe(false);
  });

  it("jwtRole reads a payload's role and survives rubbish", () => {
    expect(jwtRole(jwt({ role: "service_role" }))).toBe("service_role");
    expect(jwtRole(jwt({ role: "anon" }))).toBe("anon");
    expect(jwtRole(jwt({ sub: "x" }))).toBeNull();
    expect(jwtRole("not.a.jwt")).toBeNull();
    expect(jwtRole("")).toBeNull();
  });
});

describe("plain http:// URLs", () => {
  it.each([
    "http://example.com",
    "http://api.example.com/v1/things?x=1",
    "const u = 'http://203.0.113.9:8080/x';",
    "http://localhost.evil.com/steal",
    "http://127.0.0.1.nip.io/x",
    "http://www.w3.org/2000/svg",
  ])("flags %s", (text) => {
    expect(findHttpUrls(text)).toHaveLength(1);
  });

  it.each([
    "http://localhost",
    "http://localhost:3000/api",
    "ANTHROPIC_BASE_URL=http://127.0.0.1:4019",
    "http://[::1]:3000/x",
    "http://0.0.0.0:8080",
    "https://example.com/secure",
    "a value starting with `http://` or https://",
    "A full web address starting with http:// or https://, or blank.",
    "no url here",
  ])("lets %s through", (text) => {
    expect(findHttpUrls(text)).toEqual([]);
  });

  it("gives the line and the URL", () => {
    expect(findHttpUrls("ok\nfetch('http://api.example.com/x')\n")).toEqual([
      { line: 2, url: "http://api.example.com/x" },
    ]);
  });
});

describe("tracked files that must not exist", () => {
  it.each([
    [".env", true],
    [".env.local", true],
    [".env.production", true],
    [".env.development.local", true],
    ["apps/web/.env", true],
    ["apps/web/.env.local", true],
    [".env.example", false],
    ["apps/web/.env.example", false],
    ["docs/env.md", false],
    ["src/lib/env.ts", false],
    [".envrc.md", false],
    ["environment.ts", false],
  ])("%s is forbidden: %s", (path, forbidden) => {
    expect(isForbiddenEnvFile(path)).toBe(forbidden);
  });

  it.each([
    ["isaac-backup-2026-11-18.json", true],
    ["isaac-backup-2026-11-18.enc.json", true],
    ["Downloads/isaac-backup-x.json", true],
    ["tests/fixtures/backup.json", false],
    ["scripts/restore-backup.ts", false],
    ["docs/BACKUP.md", false],
  ])("%s is a downloaded backup: %s", (path, is) => {
    expect(isBackupFile(path)).toBe(is);
  });
});

describe("the allowlist", () => {
  const finding = {
    rule: "jwt",
    line: 3,
    preview: "eyJh... [60 chars]",
    value: `eyJhbGciOi.${"x".repeat(20)}`,
  };

  it("rejects an entry with no reason, an empty one, a missing key or a list that is not a list", () => {
    expect(() => parseAllowlist({ secrets: [{ path: "tests/a.ts" }] })).toThrow(
      /secrets\[0\] needs a non-empty "reason"/,
    );
    expect(() => parseAllowlist({ secrets: [{ path: "tests/a.ts", reason: "  " }] })).toThrow(
      /reason/,
    );
    expect(() => parseAllowlist({ http: [{ reason: "why" }] })).toThrow(
      /http\[0\] needs a non-empty "path"/,
    );
    expect(() => parseAllowlist({ advisories: [{ reason: "why" }] })).toThrow(/"id"/);
    expect(() => parseAllowlist({ secrets: "nope" })).toThrow(/must be a list/);
  });

  it("accepts a well-formed file, and an empty one", () => {
    expect(parseAllowlist({})).toEqual({ secrets: [], http: [], advisories: [] });
    const ok = {
      secrets: [{ path: "tests/a.ts", rule: "jwt", reason: "fixture" }],
      http: [],
      advisories: [],
    };
    expect(parseAllowlist(ok)).toEqual(ok);
  });

  it.each([
    [{ path: "tests/a.ts", reason: "r" }, "tests/a.ts", true],
    [{ path: "tests/a.ts", reason: "r" }, "tests/b.ts", false],
    [{ path: "tests/", reason: "r" }, "tests/deep/a.ts", true],
    [{ path: "tests/", reason: "r" }, "src/tests/a.ts", false],
    [{ path: "tests/a.ts", rule: "jwt", reason: "r" }, "tests/a.ts", true],
    [{ path: "tests/a.ts", rule: "aws-access-key", reason: "r" }, "tests/a.ts", false],
    [{ path: "tests/a.ts", rule: "*", reason: "r" }, "tests/a.ts", true],
    [{ path: "tests/a.ts", contains: "eyJhbGciOi", reason: "r" }, "tests/a.ts", true],
    [{ path: "tests/a.ts", contains: "other", reason: "r" }, "tests/a.ts", false],
  ])("secret entry %j on %s covers it: %s", (entry, path, covers) => {
    expect(secretAllowed(entry, path, finding)).toBe(covers);
  });

  it.each([
    [
      { path: "src/app/icon.svg", reason: "r" },
      "src/app/icon.svg",
      "http://www.w3.org/2000/svg",
      true,
    ],
    [
      { path: "src/app/icon.svg", url: "http://www.w3.org/", reason: "r" },
      "src/app/icon.svg",
      "http://www.w3.org/2000/svg",
      true,
    ],
    [
      { path: "src/app/icon.svg", url: "http://www.w3.org/", reason: "r" },
      "src/app/icon.svg",
      "http://evil.example/",
      false,
    ],
    [
      { path: "src/app/icon.svg", reason: "r" },
      "src/app/other.svg",
      "http://www.w3.org/2000/svg",
      false,
    ],
  ])("http entry %j on %s for %s covers it: %s", (entry, path, url, covers) => {
    expect(httpAllowed(entry, path, url)).toBe(covers);
  });
});

describe("reading pnpm audit output", () => {
  const advisory = (id: string, severity: string) => ({
    github_advisory_id: id,
    module_name: `pkg-${id}`,
    severity,
    title: `Problem ${id}`,
    url: `https://github.com/advisories/${id}`,
    vulnerable_versions: "<2.0.0",
    patched_versions: ">=2.0.0",
  });
  const out = (advisories: Record<string, unknown>) => JSON.stringify({ advisories, metadata: {} });

  it("a clean audit has no advisories", () => {
    expect(summariseAudit(out({}))).toEqual({ advisories: [], ignored: 0, total: 0 });
  });

  it("lists every advisory with what a person needs to act on it", () => {
    const { advisories, total } = summariseAudit(
      out({ 1: advisory("GHSA-aaaa", "high"), 2: advisory("GHSA-bbbb", "low") }),
    );
    expect(total).toBe(2);
    expect(advisories[0]).toEqual({
      id: "GHSA-aaaa",
      severity: "high",
      name: "pkg-GHSA-aaaa",
      title: "Problem GHSA-aaaa",
      url: "https://github.com/advisories/GHSA-aaaa",
      vulnerable: "<2.0.0",
      patched: ">=2.0.0",
    });
  });

  it("an allowlisted advisory is counted but not reported", () => {
    const r = summariseAudit(
      out({ 1: advisory("GHSA-aaaa", "high"), 2: advisory("GHSA-bbbb", "low") }),
      [{ id: "GHSA-aaaa", reason: "dev-only path" }],
    );
    expect(r.advisories.map((a) => a.id)).toEqual(["GHSA-bbbb"]);
    expect(r.ignored).toBe(1);
  });

  it.each(["", "not json", "{}", '{"advisories":null}', '{"error":{"code":"ENOTFOUND"}}', "[]"])(
    "output that is not an audit (%j) throws, so the scan fails instead of passing",
    (stdout) => {
      expect(() => summariseAudit(stdout)).toThrow();
    },
  );
});
