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
- **Already in the CRM** (same phone, or same business name when there's no phone): **no second card.** A note
  "Came in again…" is added and the follow-up moves to today. A **do-not-contact** merchant only gets the note.
- Answers: `201` created, `200` duplicate, `400` plain-words problem, `401` bad/revoked token, `413` too big,
  `429` more than 30 a minute.

## Safety

- The token can do exactly one thing: add a merchant to its owner's account. It can't read anything.
- **Keep it on a server or inside Zapier — never in a web page** (anyone could view-source it). Turn it off from the
  Lead intake page at any time; it stops working immediately. Removing the owner from `ALLOWED_EMAILS` does too.
- SSNs and card numbers in `notes` are refused, like everywhere else in the app.
- Not built yet: an instant "new lead" email or push (today it shows on Today and the morning digest), and a
  hosted form page.
