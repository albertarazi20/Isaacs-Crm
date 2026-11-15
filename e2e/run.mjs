// Local browser tests — never run in CI (CLAUDE.md). Needs `pnpm dev` with DEV_LOGIN=1 and a localhost DATABASE_URL.
//   pnpm e2e              run everything
//   pnpm e2e today        run files whose name contains "today"
import { readdirSync } from "node:fs";
import { dropUser, makeUser, summary } from "./lib.mjs";

const filter = process.argv[2] ?? "";
const files = readdirSync(new URL(".", import.meta.url))
  .filter((f) => f.endsWith(".e2e.mjs") && f.includes(filter))
  .sort();

let failed = false;
for (const file of files) {
  console.log(`\n== ${file}`);
  const email = await makeUser(file.split(".")[0]);
  try {
    // Use the file URL as-is: `.pathname` is percent-encoded, and pathToFileURL would encode it again (breaks paths with spaces).
    const mod = await import(new URL(file, import.meta.url).href);
    await mod.default({ email });
  } catch (e) {
    failed = true;
    console.log(`FAIL  ${file} crashed — ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  } finally {
    await dropUser(email);
  }
}
const { passed, total } = summary();
console.log(`\n${passed}/${total} checks passed${failed ? " (with crashes)" : ""}`);
process.exit(failed || passed !== total ? 1 : 0);
