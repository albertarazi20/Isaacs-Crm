// Pure pattern matching for scripts/security-scan.mjs: no file, git or network access here, so tests/security-scan.test.ts
// can feed it strings. A finding never carries the secret itself, only a redacted preview, because the scan's own
// output ends up in terminals, logs and screenshots.

/** @typedef {{ rule: string, line: number, preview: string, value: string }} Finding */
/** @typedef {{ path: string, rule?: string, contains?: string, reason: string }} SecretAllow */
/** @typedef {{ path: string, url?: string, reason: string }} HttpAllow */
/** @typedef {{ id: string, reason: string }} AdvisoryAllow */
/** @typedef {{ secrets: SecretAllow[], http: HttpAllow[], advisories: AdvisoryAllow[] }} Allowlist */

/** What to run, most specific first: when two rules match the same text, the earlier one is the one reported. */
const RULES = [
  {
    id: "anthropic-key",
    description: "Anthropic API key (sk-ant-...)",
    regex: /sk-ant-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: "aws-access-key",
    description: "AWS access key id (AKIA... / ASIA...)",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "private-key-block",
    description: "Private key block (-----BEGIN ... PRIVATE KEY-----)",
    regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: "supabase-service-key",
    description: "Supabase secret key (sb_secret_...)",
    regex: /\bsb_secret_[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: "supabase-service-key",
    description: "Supabase service_role JWT",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    // only a JWT whose own payload says service_role; any other JWT falls through to the generic jwt rule
    accept: (/** @type {string} */ value) => jwtRole(value) === "service_role",
  },
  {
    id: "database-url-credentials",
    description: "Database URL with a user and password in it (postgres://user:password@host)",
    regex: /\bpostgres(?:ql)?:\/\/[^\s:/@"'`]+:[^\s/@"'`]+@[^\s"'`]+/gi,
    // a stand-in password ("password", "<password>", "${DB_PASSWORD}") is documentation, not a leak
    accept: (/** @type {string} */ value) => !isPlaceholderValue(passwordOfUrl(value)),
  },
  {
    id: "resend-key",
    description: "Resend API key (re_...)",
    regex: /(?<![A-Za-z0-9_])re_[A-Za-z0-9_]{20,}/g,
    // a real key mixes digits in; a snake_case identifier that happens to start with re_ does not
    accept: (/** @type {string} */ value) => /\d/.test(value) && !PLACEHOLDER.test(value),
  },
  {
    id: "github-token",
    description: "GitHub token (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_)",
    regex: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g,
  },
  {
    id: "netlify-token",
    description: "Netlify personal access token (nfp_...)",
    regex: /(?<![A-Za-z0-9_])nfp_[A-Za-z0-9]{20,}/g,
  },
  {
    id: "stripe-live-key",
    description: "Stripe live secret or restricted key (sk_live_ / rk_live_)",
    regex: /(?<![A-Za-z0-9_])(?:sk|rk)_live_[A-Za-z0-9]{16,}/g,
  },
  {
    id: "jwt",
    description: "JWT-looking token (eyJ...)",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
];

/** A name that suggests a secret, then `=` or `:`, then a long value (hex, base64 or base64url). */
const ASSIGNMENT =
  /(?:KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*["'`]?\s*(?::=|:|=)\s*["'`]?([A-Za-z0-9+/_=-]{32,})["'`]?/gi;

/**
 * The names of the app's own secrets. Any literal value given to one of these is a finding unless it is an obvious
 * stand-in, however short or ordinary it looks: a weak passcode is exactly the thing to catch. Matches `NAME=value`,
 * `NAME: value`, `NAME := value` and `"NAME": "value"`; a bare (unquoted) value counts only at the start of a line
 * (an env file, a shell export, a YAML key), because in code an unquoted value is a variable, not a literal.
 */
const NAMED_SECRETS = [
  "ACCESS_PASSCODE",
  "SESSION_SECRET",
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "SUPABASE_SERVICE_KEY",
];
const NAMED_ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9_$])(?:${NAMED_SECRETS.join("|")})(["'\`]?)[ \\t]*(?::=|:|=)(?![=>])[ \\t]*(?:(["'\`])((?:(?!\\2).)*)\\2|([^\\s"'\`;,)]+))`,
  "gd",
);
const TYPE_WORDS = /^(?:string|number|boolean|unknown|any|never|undefined|null|void|object)$/i;

/** True for a value that is empty, a reference to a variable, or an obvious stand-in rather than a literal credential. */
export function isPlaceholderValue(/** @type {string} */ value) {
  const v = value.trim();
  if (v === "") return true;
  if (PLACEHOLDER.test(v)) return true;
  // references: $VAR, ${VAR}, %VAR%, {{ var }}, process.env.X, env().X, import.meta.env.X, secrets.X
  if (
    /^\$|^%[A-Za-z_]+%$|^\{\{.*\}\}$|^\$\{|process\.env|import\.meta\.env|\benv\(|^secrets\./i.test(
      v,
    )
  )
    return true;
  // masks and fill-in-the-blank markers: ***, ..., <your password>, [YOUR-PASSWORD], xxx
  if (/^[*.x#_…-]+$/i.test(v) || /^<.*>$/.test(v) || /^\[.*\]$/.test(v)) return true;
  // an elided value: "postgres://…", "postgres://user:pass@host/..."
  if (/(?:…|\.\.\.)$/.test(v)) return true;
  if (
    /^(?:none|null|undefined|false|true|password|passwd|pass|pwd|passcode|secret|tbd|n\/a)$/i.test(
      v,
    )
  )
    return true;
  return false;
}

/** The password inside a database URL, "" when there is none. */
export function passwordOfUrl(/** @type {string} */ url) {
  const m = /^[a-z]+:\/\/[^:/@\s]*:([^@\s]*)@/i.exec(url);
  return m?.[1] ?? "";
}

/** A local database address with no password in it: a development default, not a credential. */
function isPasswordlessLocalUrl(/** @type {string} */ v) {
  return (
    /^postgres(?:ql)?:\/\/[^:@/\s]*@(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/?]|$)/i.test(v) ||
    /^postgres(?:ql)?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/?]|$)/i.test(v)
  );
}

/** Words that mark a value as a stand-in, not a real credential. */
const PLACEHOLDER =
  /example|placeholder|changeme|change-me|your[-_ ]|dummy|stub|sample|xxxx|redacted|todo/i;

/** @param {string} value */
export function jwtRole(value) {
  try {
    const payload = value.split(".")[1] ?? "";
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json?.role === "string" ? json.role : null;
  } catch {
    return null;
  }
}

/** Bits of entropy per character: a random token scores about 3.5 or more, a word or a repeated pattern far less. */
export function entropy(/** @type {string} */ s) {
  if (s.length === 0) return 0;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

/** True when a value assigned to a secret-sounding name looks like a real random credential. */
export function looksRandom(/** @type {string} */ value) {
  if (PLACEHOLDER.test(value)) return false;
  // an id, not a secret that anyone could replay
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return false;
  if (/^[0-9a-f]+$/i.test(value)) return /\d/.test(value) && entropy(value) >= 3;
  // base64 / base64url: letters and digits mixed, and not words or a path (two words each followed by a
  // separator is how a name or path reads; a random token almost never does)
  if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
  if (/(?:[a-z]{3,}[-_/]){2,}/i.test(value)) return false;
  return entropy(value) >= 3.5;
}

/**
 * A short, safe preview: the first four characters and how long the value is. A short value (a weak passcode would be
 * one) shows only its length, because four characters of it would be most of it.
 */
export function redact(/** @type {string} */ value) {
  return value.length < 16
    ? `[${value.length} chars]`
    : `${value.slice(0, 4)}... [${value.length} chars]`;
}

/** A URL safe to print: the user and password are gone, and so is everything from the query string on. */
export function redactUrl(/** @type {string} */ url) {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/i, "$1***@")
    .replace(/[?#].*$/, (rest) => `${rest[0]}...`);
}

/**
 * Likely secrets in one file's text.
 * @param {string} text
 * @returns {Finding[]}
 */
export function scanText(text) {
  /** @type {Finding[]} */
  const found = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    // Where on the line each finding sits: a later, less specific rule that lands on the same text is not reported twice
    // (the assignment rule sees only the first segment of a JWT sitting on a KEY name, for one).
    /** @type {[number, number][]} */
    const taken = [];
    const add = (
      /** @type {string} */ rule,
      /** @type {string} */ value,
      /** @type {number} */ at,
    ) => {
      const end = at + value.length;
      if (taken.some(([s, e]) => at < e && end > s)) return;
      taken.push([at, end]);
      found.push({ rule, line: i + 1, preview: redact(value), value });
    };
    for (const r of RULES) {
      for (const m of line.matchAll(r.regex)) {
        if (r.accept && !r.accept(m[0])) continue;
        add(r.id, m[0], m.index ?? 0);
      }
    }
    for (const m of line.matchAll(ASSIGNMENT)) {
      const value = m[1] ?? "";
      if (looksRandom(value)) add("secret-assignment", value, (m.index ?? 0) + m[0].indexOf(value));
    }
    for (const m of line.matchAll(NAMED_ASSIGNMENT)) {
      const quoted = m[3] !== undefined;
      const value = (quoted ? m[3] : m[4]) ?? "";
      const at = m.indices?.[quoted ? 3 : 4]?.[0] ?? 0;
      if (!quoted && !/^[\s>*`_-]*(?:export\s+|set\s+|ENV\s+)?$/i.test(line.slice(0, m.index ?? 0)))
        continue; // code, not a literal
      if (!quoted && (TYPE_WORDS.test(value) || /[(){}<>]/.test(value))) continue;
      if (quoted && /\$\{/.test(value)) continue; // a template with a reference in it
      if (isPlaceholderValue(value) || isPasswordlessLocalUrl(value)) continue;
      add("named-secret-assignment", value, at);
    }
  });
  return found;
}

const HTTP =
  /\bhttp:\/\/(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?![\w.-]))[^\s"'`)<>\\]+/g;

/**
 * Plain-http URLs that are not the machine itself.
 * @param {string} text
 * @returns {{ line: number, url: string }[]}
 */
export function findHttpUrls(text) {
  /** @type {{ line: number, url: string }[]} */
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(HTTP)) out.push({ line: i + 1, url: m[0] });
  });
  return out;
}

/** True for a tracked file that must not be in git: .env and .env.* except .env.example (at any depth). */
export function isForbiddenEnvFile(/** @type {string} */ path) {
  const name = path.split("/").pop() ?? "";
  return /^\.env(\..+)?$/.test(name) && name !== ".env.example";
}

/** True for a tracked file that looks like a downloaded backup (customer data, never in git). */
export function isBackupFile(/** @type {string} */ path) {
  return /(^|\/)isaac-backup-[^/]*\.json$/.test(path);
}

/** The allowlist's `path` is an exact path, or a directory prefix ending in "/". */
function pathMatches(/** @type {string} */ entry, /** @type {string} */ path) {
  return entry.endsWith("/") ? path.startsWith(entry) : path === entry;
}

/**
 * Throws a sentence for a person when the allowlist is malformed: every entry must say why it is allowed.
 * @param {unknown} raw
 * @returns {Allowlist}
 */
export function parseAllowlist(raw) {
  const o = /** @type {Record<string, unknown>} */ (raw && typeof raw === "object" ? raw : {});
  /** @param {string} key @param {string[]} needs */
  const list = (key, needs) => {
    const v = o[key] ?? [];
    if (!Array.isArray(v)) throw new Error(`security-allowlist.json: "${key}" must be a list`);
    v.forEach((entry, i) => {
      for (const field of ["reason", ...needs]) {
        const value = entry?.[field];
        if (typeof value !== "string" || value.trim() === "")
          throw new Error(`security-allowlist.json: ${key}[${i}] needs a non-empty "${field}"`);
      }
    });
    return v;
  };
  return {
    secrets: list("secrets", ["path"]),
    http: list("http", ["path"]),
    advisories: list("advisories", ["id"]),
  };
}

/**
 * Whether an allowlist entry covers a secret finding.
 * @param {SecretAllow} entry @param {string} path @param {Finding} finding
 */
export function secretAllowed(entry, path, finding) {
  if (!pathMatches(entry.path, path)) return false;
  if (entry.rule && entry.rule !== "*" && entry.rule !== finding.rule) return false;
  if (entry.contains && !finding.value.includes(entry.contains)) return false;
  return true;
}

/**
 * Whether an allowlist entry covers a plain-http URL.
 * @param {HttpAllow} entry @param {string} path @param {string} url
 */
export function httpAllowed(entry, path, url) {
  return pathMatches(entry.path, path) && (!entry.url || url.startsWith(entry.url));
}

/**
 * Reads `pnpm audit --json` output. Returns the advisories that are not allowlisted, or throws when the output is not an audit.
 * @param {string} stdout @param {AdvisoryAllow[]} ignore
 * @returns {{ advisories: { id: string, severity: string, name: string, title: string, url: string, vulnerable: string, patched: string }[], ignored: number, total: number }}
 */
export function summariseAudit(stdout, ignore = []) {
  const json = JSON.parse(stdout);
  if (!json || typeof json !== "object" || typeof json.advisories !== "object" || !json.advisories)
    throw new Error("the audit did not return a list of advisories");
  const skip = new Set(ignore.map((a) => a.id));
  const all = Object.values(
    /** @type {Record<string, Record<string, unknown>>} */ (json.advisories),
  );
  const advisories = all
    .map((a) => ({
      id: String(a.github_advisory_id ?? a.id ?? ""),
      severity: String(a.severity ?? "unknown"),
      name: String(a.module_name ?? "unknown"),
      title: String(a.title ?? ""),
      url: String(a.url ?? ""),
      vulnerable: String(a.vulnerable_versions ?? ""),
      patched: String(a.patched_versions ?? ""),
    }))
    .filter((a) => !skip.has(a.id));
  return { advisories, ignored: all.length - advisories.length, total: all.length };
}
