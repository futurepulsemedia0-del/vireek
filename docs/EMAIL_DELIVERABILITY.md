# Email deliverability checklist (SPF / DKIM / DMARC)

Vireek sends transactional mail through Resend (`_shared/notify/deliver.ts`, secrets `RESEND_API_KEY`, `RESEND_FROM_EMAIL`).
Do these once per sending domain. **None of this can be verified from the repository** — it lives in your DNS and Resend dashboard.

## 1. Authenticate the domain
- [ ] Resend → Domains → add the domain you send from (e.g. `mail.vireek.com`; use a subdomain, not the root).
- [ ] Add the DNS records Resend shows, exactly as given:
  - **SPF** — a `TXT` record on the sending (sub)domain that includes Resend. One SPF record per domain; merge, never duplicate.
  - **DKIM** — the `CNAME`/`TXT` selector records.
  - **Return-path / MX** records if Resend lists them (needed for DMARC alignment).
- [ ] Wait for "Verified" in Resend before changing `RESEND_FROM_EMAIL`.

## 2. DMARC
- [ ] `_dmarc.<domain>` `TXT`: start with `v=DMARC1; p=none; rua=mailto:dmarc@<your-domain>; adkim=s; aspf=s`.
- [ ] Review the aggregate reports for 2–4 weeks; every legitimate sender must pass SPF **or** DKIM *aligned* with the From domain.
- [ ] Move to `p=quarantine`, then `p=reject` once reports are clean.

## 3. From address and content
- [ ] `RESEND_FROM_EMAIL` uses the verified domain, e.g. `Vireek <security@mail.vireek.com>`.
- [ ] Reply-to is a monitored inbox (the footer says "reply to this email").
- [ ] Every HTML email has a plain-text twin (the kit always generates one).
- [ ] Security/transactional mail carries no marketing content and needs no unsubscribe link. Anything promotional must pass `preferencesUrl` to `renderEmail` and include `List-Unsubscribe` / one-click headers.

## 4. Verify
- [ ] `/dev/emails` → "Send to myself" (set `ENABLE_EMAIL_PREVIEW_SEND=true` on `email-preview-send` temporarily; turn it off again).
- [ ] In Gmail: Show original → `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`.
- [ ] Send a sample to mail-tester.com (or similar) and aim for ≥ 9/10.
- [ ] View in Gmail (web + app, light/dark), Apple Mail, Outlook desktop (Word renderer) and Outlook.com.
