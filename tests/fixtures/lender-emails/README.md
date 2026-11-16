# Lender-email corpus

The labelled emails the reader (`src/lib/ai/readLenderEmail.ts`) is measured against. The seven `00x-*.json` files
are synthetic. Real ones make the measurement real: the plan asks for 100–200, added by the owner.

Run it with `node scripts/eval-reader.mjs` (needs `ANTHROPIC_API_KEY`; without it the files are only checked for
shape). It prints PASS / MISS per file and accuracy per event. `--strict` exits 1 on any miss.

## Adding a real email

1. Copy the email's plain text (not the HTML) into a new file named `NNN-<lender>-<event>.json`, the next number
   in line. Take out anything a lender email should not keep in a repo: account numbers, SSNs, EINs, dates of birth.
   The business name, the terms and the lender's wording are what the reader is tested on, so keep those.
2. Fill in what a person reading the email would say it means. Only the fields you fill in are checked.

```json
{
  "name": "one line on what this email is",
  "source": "real",
  "input": {
    "from": "Jane <jane@lender.com>",
    "subject": "Re: [D-1042] Mike's Pizza",
    "text": "the email body, as plain text",
    "attachmentNames": ["Offer.pdf"]
  },
  "expected": {
    "event": "approved",
    "offer": { "amount_dollars": 45000, "factor_rate": 1.35, "term_days": 120 },
    "offers_count": 1,
    "decline_reason": null,
    "portal_link_only": false,
    "stips_requested_includes": ["voided check"]
  }
}
```

- `event` is one of the reader's fixed list: `submitted`, `info_requested`, `approved`, `revised`, `declined`,
  `docs_out`, `contracts_in`, `bv_done`, `stip_requested`, `funding_call_done`, `funded`, `killed`, `no_change`,
  `merchant_replied`.
- `offer` lists only the terms you want checked; numbers pass within 1 %.
- `decline_reason` uses the keys in `decline_reasons` (`low_balances`, `nsfs`, `position`, …).
- `stips_requested_includes` passes when each phrase appears (any case) in one of the stips the reader listed.

A miss on a real email is a prompt problem, not a label problem, unless two people would read the email differently —
then the email is a bad test and should go.
