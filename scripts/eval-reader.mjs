#!/usr/bin/env node
/**
 * The lender-email reader's eval harness (S2-17). Runs every labelled email under tests/fixtures/lender-emails/
 * through the reader and reports accuracy per event, so a prompt change is measured, not felt.
 *
 *   node scripts/eval-reader.mjs            # needs ANTHROPIC_API_KEY; without it the corpus is only validated
 *   node scripts/eval-reader.mjs --strict   # exit 1 when any case misses
 *   READER_MODEL=claude-sonnet-5-5 node scripts/eval-reader.mjs
 *
 * Every case costs one model call. The fixtures' README says how to add a real email.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "tests", "fixtures", "lender-emails");
const strict = process.argv.includes("--strict");

const EVENTS = new Set([
  "submitted",
  "info_requested",
  "approved",
  "revised",
  "declined",
  "docs_out",
  "contracts_in",
  "bv_done",
  "stip_requested",
  "funding_call_done",
  "funded",
  "killed",
  "no_change",
  "merchant_replied",
]);

/** The corpus shape: a bad file is a mistake in the repo, not a reader miss. Returns the problems found. */
function shapeProblems(name, c) {
  const out = [];
  const str = (v) => typeof v === "string";
  if (!str(c?.name)) out.push("name must be a string");
  if (!c?.input || !str(c.input.from) || !str(c.input.subject) || !str(c.input.text))
    out.push("input needs from, subject and text strings");
  if (c?.input?.attachmentNames !== undefined && !Array.isArray(c.input.attachmentNames))
    out.push("input.attachmentNames must be an array");
  if (!c?.expected || !EVENTS.has(c.expected.event))
    out.push(`expected.event must be one of ${[...EVENTS].join(", ")}`);
  if (
    c?.expected?.offer !== undefined &&
    c.expected.offer !== null &&
    typeof c.expected.offer !== "object"
  )
    out.push("expected.offer must be an object of the offer fields to check");
  if (
    c?.expected?.stips_requested_includes !== undefined &&
    !Array.isArray(c.expected.stips_requested_includes)
  )
    out.push("expected.stips_requested_includes must be an array of substrings");
  return out.map((p) => `${name}: ${p}`);
}

async function loadCorpus() {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const cases = [];
  const problems = [];
  for (const f of files) {
    let c;
    try {
      c = JSON.parse(await readFile(join(dir, f), "utf8"));
    } catch (e) {
      problems.push(`${f}: not JSON (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    problems.push(...shapeProblems(f, c));
    cases.push({ file: f, ...c });
  }
  return { cases, problems };
}

/** What the reader got wrong on one case, in words; empty when it got everything the label asks for. */
function misses(expected, got, unsupported, problems) {
  const out = [];
  if (got.event !== expected.event) out.push(`event: wanted ${expected.event}, got ${got.event}`);
  if (expected.portal_link_only !== undefined && got.portal_link_only !== expected.portal_link_only)
    out.push(`portal_link_only: wanted ${expected.portal_link_only}, got ${got.portal_link_only}`);
  if (expected.decline_reason !== undefined && got.decline_reason !== expected.decline_reason)
    out.push(`decline_reason: wanted ${expected.decline_reason}, got ${got.decline_reason}`);
  if (expected.offers_count !== undefined && got.offers_count !== expected.offers_count)
    out.push(`offers_count: wanted ${expected.offers_count}, got ${got.offers_count}`);
  if (expected.offer) {
    if (!got.offer) out.push("offer: wanted terms, got none");
    else
      for (const [k, want] of Object.entries(expected.offer)) {
        const have = got.offer[k];
        const close =
          typeof want === "number" && typeof have === "number"
            ? Math.abs(have - want) <= Math.abs(want) * 0.01 + 1e-9
            : have === want;
        if (!close) out.push(`offer.${k}: wanted ${want}, got ${have}`);
      }
  }
  for (const s of expected.stips_requested_includes ?? []) {
    const hay = (got.stips_requested ?? []).map((x) => String(x).toLowerCase());
    if (!hay.some((x) => x.includes(String(s).toLowerCase())))
      out.push(`stips: nothing mentions "${s}"`);
  }
  if (unsupported.length) out.push(`unsupported quotes: ${unsupported.join(", ")}`);
  if (problems.length) out.push(`checks: ${problems.join(", ")}`);
  return out;
}

const { cases, problems } = await loadCorpus();
if (problems.length) {
  console.error(`Corpus problems:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Corpus: ${cases.length} labelled emails in ${dir}`);
if (!process.env.ANTHROPIC_API_KEY) {
  console.log("ANTHROPIC_API_KEY is not set: corpus validated, reader not run.");
  process.exit(0);
}

const reader = await tsImport(
  pathToFileURL(join(here, "..", "src", "lib", "ai", "readLenderEmail.ts")).href,
  import.meta.url,
);
const model = process.env.READER_MODEL || "claude-opus-5-5";
const byEvent = new Map();
let right = 0;
let costCents = 0;
for (const c of cases) {
  const input = { ...c.input, attachmentNames: c.input.attachmentNames ?? [] };
  let line;
  try {
    const out = await reader.readLenderEmail(input, { model });
    costCents += reader.costCents(out.model, out.inputTokens, out.outputTokens);
    const m = misses(c.expected, out.result, out.unsupported, out.problems);
    const ok = m.length === 0;
    if (ok) right += 1;
    const tally = byEvent.get(c.expected.event) ?? { n: 0, ok: 0 };
    tally.n += 1;
    if (ok) tally.ok += 1;
    byEvent.set(c.expected.event, tally);
    line = `${ok ? "PASS" : "MISS"}  ${c.file}${ok ? "" : `\n        ${m.join("\n        ")}`}`;
  } catch (e) {
    const tally = byEvent.get(c.expected.event) ?? { n: 0, ok: 0 };
    tally.n += 1;
    byEvent.set(c.expected.event, tally);
    line = `FAIL  ${c.file}\n        ${e instanceof Error ? e.message : String(e)}`;
  }
  console.log(line);
}
console.log("\nAccuracy per event:");
for (const [event, t] of [...byEvent.entries()].sort()) {
  console.log(`  ${event.padEnd(18)} ${t.ok}/${t.n}  ${Math.round((100 * t.ok) / t.n)}%`);
}
console.log(
  `\nOverall: ${right}/${cases.length} (${Math.round((100 * right) / cases.length)}%), model ${model}, about ${costCents.toFixed(2)}¢`,
);
if (strict && right < cases.length) process.exit(1);
