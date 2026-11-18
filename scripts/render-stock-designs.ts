// Renders the four Selective Capital approval designs for a sample merchant: one PNG per design (600px wide, Chrome)
// and the plain-text part as a .txt, so they can be looked at without sending anything.
//   pnpm exec tsx scripts/render-stock-designs.ts [output folder]
// Images load from selectivecap.com, so this needs the network. Not part of CI.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  fillApprovalEmail,
  htmlToText,
  preheaderText,
  type ApprovalValues,
} from "../src/lib/approvals/html";
import { STOCK_DESIGNS } from "../src/lib/approvals/stock";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const out = process.argv[2] ?? join(process.cwd(), "stock-design-screens");
const NAMES = ["01-approval-email", "02-follow-up-1", "03-follow-up-2", "04-follow-up-3"];

const SAMPLE: ApprovalValues = {
  first_name: "Mike",
  business_name: "Harbor & Pine Cafe",
  offer_amount: "$85,000",
  offer_expiry: "Friday, Nov 21",
  rep_name: "Josh",
  rep_phone: "(561) 915-1002",
  rep_email: "josh@selectivecap.com",
  unsubscribe_link: "https://crm.test/u/sample",
};

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage({
    viewport: { width: 600, height: 900 },
    deviceScaleFactor: 2,
  });
  for (const [i, d] of STOCK_DESIGNS.entries()) {
    const filled = fillApprovalEmail(d, SAMPLE);
    if (filled.missing.length > 0 || filled.unfilled.length > 0)
      throw new Error(
        `${d.name} has fields left: ${[...filled.missing, ...filled.unfilled].join(", ")}`,
      );
    const name = NAMES[i] ?? `0${i + 1}`;
    await page.setContent(filled.html, { waitUntil: "networkidle" });
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
    const text = [
      `Subject: ${filled.subject}`,
      `Inbox preview: ${preheaderText(filled.html)}`,
      `Sent: ${i === 0 ? "right away, when the approval is marked" : `${d.delayHours} hours after the ${i === 1 ? "approval email" : STOCK_DESIGNS[i - 1]?.name}, if the merchant has not replied`}`,
      "",
      htmlToText(filled.html),
      "",
    ].join("\n");
    writeFileSync(join(out, `${name}.txt`), text);
    console.log(`${name}: ${filled.subject}`);
  }
} finally {
  await browser.close();
}
