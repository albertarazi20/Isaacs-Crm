# UI wiring after the design merge — what the new backends still need on the pages

Source: the three stream reports + the AI-pages branch. Every item has a working action/query; the page part is missing.

## Settings (stream 1 + 2 + 3)

- Email & lenders: "Check DNS" button → `checkAutomationDnsAction`; show automation_dns_ok / checked_at / detail; the automation domain field.
- Me / shop: `sendOnHolidays` in `saveShopSettingsAction`; theme switch also on the Me page (ThemeSwitch).
- Shop settings form (stream 2): `approval_valid_days` (default validity), `deals_inbox_address`, `resubmit_block_days`, chase mode now off / draft / send.
- Lender form: blank "approval valid days" = shop default (nullable now).
- Buckets & templates: template approval refusal shows the claim-checker reasons; template and bucket scores (`templateScores`, `bucketScores`) as a small table per template/bucket; paused_at + reason badge on a template auto-paused by a bounce spike; "Approve again" clears it.
- Money: document retention days (shop setting); the commission statements list per month (`commission_statements`) with a download/print; `correct_funding` as "Correct this funding" (manager) with a reason.
- Team & trust: backdoor score per lender (`trust/queries.ts`), policy acceptance status per person; the trust alerts explained.
- AI: last-synced per mailbox (`mailboxSyncStatus`), the opener mode auto/review, the new AI purposes in the spend list.
- State rules & registrations: a small editor for `state_rules` / `shop_registrations` (lawyer-maintained table) and renewal dates.

## Lead Intake (stream 1)

- Paste a lead line box → `splitLeadLineAction` fills the form.
- Duplicate warning shows the cross-rep owner line ("Already in the system: Mike's lead, in Missing statements, touched 3 days ago"); manager override toggle.
- Bulk intake: pick N staged sheet rows + bucket → `fileSheetRowsAction` with per-row results.

## Follow Up (stream 1)

- Reply tag chip on the lead line (interested / sending docs / not now + revive date / wrong person / stop).
- Pause with a date (`pauseEnrollmentAction` → set_enrollment_paused) and the "paused until" label.
- Bucket scores in the bucket header; template scores on the template picker.

## Submission Board / Deals (stream 2 + AI)

- Review tray: "Undo" on an applied AI update → `revert_ai_update`; the pasted-text and screenshot imports (`importPastedOfferAction`, `importOfferImageAction`) on the Offers tab (manager).
- Deal page: "Ask manager" button → ask-a-manager action; "Ask a question" box on Activity → `askDealAction` (answer + citations that scroll to the event); reshop candidates + "Start reshop" → `reshopCandidates` / `startReshop`; the state badge + warnings (`stateCompliance` in funders/states.ts) in the header; stips.label shown for 'other' stips; application link: copy / send, and the latest signed application (`latestApplication`) on Documents.
- My Deals: "Eligible for more funds" filter (`listDeals(q, "more_funds")`).
- Board: chase draft alerts (kind chase_draft) surface in the ops queue with "Send" / "Edit".

## Dashboard / alerts (stream 3)

- The alert feed page (`/alerts`): list user_alerts, mark read, link through; the bell count in the header.
- Speed numbers (lead→sub, sub→offer, approval→funded) and kickback rate on the rep table.
- Morning brief has yesterday's numbers (email only; nothing on the page).

## Winback / Funded (stream 3)

- Why-not-funded pick-list on a member; the opener review tray (auto / review mode; "Send all"); recovered money per pool and template; the rescue nudges shown on the member row.
- Funded: statements per month; late lender payouts flag; corrections as dated lines; "Start renewal" → `start_renewal`; eligible-for-more-funds.

## Public pages

- `/apply/[token]` exists (functional); match the upload page's design once D3 lands.
- Policy acceptance gate at first login (`accept_policy`), a one-screen interstitial.
