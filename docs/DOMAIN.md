# What an MCA shop actually tracks

Written 2026-10-20 as the starting model. **Not yet confirmed with the client** — every section
below is marked CONFIRM where it needs his word. Do not build on an unconfirmed assumption.

## The one thing to get right
A merchant cash advance is **not a loan**. The funder buys a slice of the business's **future
receivables** at a discount. That difference drives the vocabulary, and using loan words in the UI
is how a CRM gets dismissed by the people who have to use it:

| say this | not this |
|---|---|
| advance / funding amount | loan / principal |
| factor rate (e.g. 1.32) | interest rate / APR |
| payback (amount × factor) | amount due |
| remittance (daily / weekly) | payment / installment |
| term (estimated) | maturity |
| merchant | borrower |

## Core records
- **Merchant** — the business. Legal name, DBA, EIN, entity type, industry/SIC, address, time in
  business, monthly revenue, average daily balance, NSF count.
- **Owner / guarantor** — person(s) behind it. Name, ownership %, DOB, FICO band, contact. Usually
  signs a personal guarantee. One merchant can have several.
- **Application** — one submission attempt. Carries the stips.
- **Stips** (stipulations) — the documents underwriting demands: typically 3–6 months of bank
  statements, driver's licence, voided cheque, sometimes tax returns or a landlord/lease letter.
  Each stip is received / missing / rejected.
- **Submission** — the application sent to a specific **funder**. One application fans out to many
  funders. This is the record most home-grown MCA CRMs get wrong by modelling it as one-to-one.
- **Offer** — what a funder comes back with: amount, factor rate, payback, remittance amount and
  frequency, estimated term, fees, **position**.
- **Deal / advance** — a funded offer. The live thing being serviced.
- **Commission** — what the shop earns, usually points on the funded amount, often split with the
  rep and sometimes a referral partner.

## Position matters, and it is a first-class field
MCA deals stack. **1st position** is the only advance on the business; **2nd / 3rd position** sit
behind existing ones. Position changes pricing, approval odds and risk, and funders filter on it.
It belongs on the offer and on the deal, not in a note.

## Pipeline — CONFIRM these stages with the client before building them
Lead → Application in → Stips collected → Submitted to funders → Offers in → Offer presented →
Contract out → **Funded** → Servicing → Renewal / Refi, with **Declined** and **Dead** as exits.

Renewals are the heart of the business — a merchant who paid off is the best lead the shop has.
The CRM must make "who is 50%+ paid down" a one-click list.

## Things that will come up, flagged early
- **Reps and splits.** Commission splits between house, rep and referral source. CONFIRM the rule.
- **Funder list.** Each funder has its own appetite: position, industry exclusions, minimum
  revenue, state restrictions. A submission to a funder that excludes the industry is wasted work.
- **Industry exclusions.** Most funders decline some industries outright. CONFIRM his list.
- **State rules.** Commercial financing disclosure law exists in several states (NY and CA among
  them) and the rules differ. **Do not generate any disclosure document until the client confirms
  which states he operates in and what his counsel says.** Flag it, do not guess it.
- **Duplicate merchants.** The same business comes back under a slightly different DBA constantly.
  Dedupe on EIN first, then normalised legal name + address.

## Open questions for the client
1. Does he submit to outside funders, fund himself, or both?
2. How many reps, and how are splits calculated?
3. Which funders, and what does each one's appetite look like?
4. Which states does he write business in?
5. Does he need syndication tracking (investors taking a piece of a deal), or not yet?
