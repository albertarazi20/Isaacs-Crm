# Lead intake — new merchants straight onto Today

A new inbound lead is the most time-sensitive thing in this business. This sends one from a website form,
Zapier or a lead vendor into the CRM as a **"call now" follow-up due today**, with no CSV.

## Set up (2 minutes, in the app)

1. Clients → **Lead intake** → name the connection (e.g. "My website") → **Make a connection**.
2. Copy the token. **It is shown once.** Only a fingerprint (SHA-256) is stored.
3. Send a `POST` to `<your app>/api/leads` with `Authorization: Bearer <token>` and a JSON body.

```sh
curl -X POST https://YOUR-APP/api/leads \
  -H "Authorization: Bearer isl_…" -H "Content-Type: application/json" \
  -d '{"businessName":"Mike'"'"'s Pizza","contactName":"Mike Ross","phone":"305-555-0100","wantedAmount":"50k","source":"My website"}'
```

Fields: `businessName`, `contactName`, `phone`, `email`, `wantedAmount`, `industry`, `state`, `source`, `notes`.
Send a phone or an email, and a business or contact name. Anything else (a stage, an id) is ignored.

**Zapier / Make:** use a _Webhooks → POST_ action, header `Authorization: Bearer <token>`, data type JSON.

## What happens

- **New merchant:** stage _Name in_, follow-up due **today** with the note "New lead — call now", source from the
  request (or "Lead intake"), the amount wanted saved, notes on the timeline.
- **Already in the CRM:** **no second card.** A note "Came in again…" (with whatever the lead sent: amount, source,
  notes) is added and the follow-up moves to today. A **do-not-contact** merchant only gets the note.
  Matching rule: same phone always matches. Same business name matches **only** when the lead has no phone, or the
  card on file has none — two Subways with two different phones stay two cards. The answer says which rule fired
  (`matchedOn`: `"phone"` or `"name"`).
- Two copies of one lead arriving at the same instant (a double-fired Zap) still make one card: the intake
  serialises on the phone and name key inside the database.
- `null` for an optional field is the same as leaving it out (Zapier sends `null` for empty fields).
- Answers: `201` created, `200` duplicate, `400` plain-words problem naming the field, `401` bad/revoked token,
  `413` too big, `429` more than 30 a minute or 200 new merchants a day, `503` + `Retry-After` when the database was briefly busy (retry the
  same request; it is safe), `500` anything else.

## Safety

- The token adds a merchant to its owner's account. It can't read the CRM, but the reply does tell the sender whether
  that phone number is already on file (`created` vs `duplicate`), and a duplicate adds a note and moves that
  merchant's follow-up to today. Give a token only to a sender you trust with that.
- **Daily cap:** one token adds at most 200 new merchants a UTC day (`429`, retry after an hour). Duplicates don't
  count. A leaked token can't bury Today in junk past that.
- **Marked on the card:** every new merchant gets a timeline line `Added by lead connection "<name>"`, so after
  you turn a leaked connection off you can find what it added.
- **Keep it on a server or inside Zapier — never in a web page** (anyone could view-source it). Turn it off from the
  Lead intake page at any time; it stops working immediately. So does disabling the owner's account in Settings > Team
  (or deleting it). `ALLOWED_EMAILS` plays no part: accounts are the allowlist, and the lead route only needs the token
  to belong to an active account.
- SSNs and card numbers in `notes` are refused, like everywhere else in the app.
- **Instant alert:** when Resend is configured, a brand-new lead emails the owner right away ("New lead: Mike's
  Pizza — call now"). At most 20 alerts a day, one per lead, off when the reminder switch in Settings is off.
  A failed alert never fails the request — the lead is saved first. (Proven on a production build with a
  failing Resend key; the real delivery needs the Resend account.)
- Not built yet: push notifications, an alert when a known merchant re-submits, and a hosted form page.
