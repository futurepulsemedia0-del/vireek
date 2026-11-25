# Licensing audit — financing, payments, escrow (engineering inventory)

Status: engineering inventory only. **Not legal advice. No conclusion below is a licensing determination.**
Every "Possible licence area" cell is a question for counsel, not an answer. TODO(counsel) on every row.
Audited from the repository snapshot supplied on 2026-11-24 (code read, nothing executed against a database).

## 1. Code paths

| # | Path | What it does (verified in code) | Money / credit flow | Possible licence area (TODO(counsel)) | Gate after this change |
|---|---|---|---|---|---|
| 1 | `supabase/functions/financing-create-offer`, `financing-webhook`, `_shared/financing/providers/wisetack.ts`, tables `financing_connections`, `financing_offers` | Creates a Wisetack BNPL offer for a job, texts/emails the customer a link, marks the invoice paid when the provider reports `funded` | Provider lends and pays; Vireek stores status only | Loan broker / lead referral / solicitation, state consumer-lending rules, marketing consent | `licensing_gate: bnpl_legacy`. Edge function returns 403; DB trigger refuses `financing_offers` INSERT. Webhook still processes events for existing offers. |
| 2 | `financing-partner-offer`, `-webhook`, `-insurance`, `-wc-share`, `_shared/financing-partners/*`, migration `20290301000000` | Partner-hosted consumer financing, working-capital signal sharing (consent-gated), insurance referrals | Partner lends/insures; Vireek stores references and coarse status | Broker/referral licences, insurance producer licensing for referral compensation, commercial-financing disclosure laws | Already gated by `fin_gate` (flag + entitlement + counsel-attested region rule). Now also `licensing_gate: financing_partners`. |
| 3 | `pay-transfer-request`, `pay-card-manage`, `capital-manage`, `pay-webhook`, `_shared/pay/*`, migrations `20271102000000`, `…0100` | Instant payouts, earned-wage access, spend cards, capital pre-screen/referral | Licensed partner moves funds / issues cards / decides credit; sandbox is a labelled fixture | Money transmission (via partner), EWA state regimes, card programme/BIN sponsorship, lender referral | Already gated by `pay_product_state` (enabled, kill, tenant freeze, agreement ref, reviewed disclosures). Now `mode='live'` also needs `licensing_gate: pay_<product>`. |
| 4 | `instant-payouts`, `_shared/instantPayouts/*` | Stripe Connect Express instant payout of the connected account's own balance; fee mirrors Stripe platform pricing (env `INSTANT_PAYOUT_FEE_BPS`) | Stripe moves funds | Depends on Stripe's role vs Vireek's; fee charged to the business | **Not gated.** Open decision (section 3). |
| 5 | `create-payment-request`, `public-payment`, `payment-plan-pay`, `terminal-payments`, `split-payment`, `_shared/payments/paymentIntent.ts`, `_shared/membershipRenewal/stripeCharger.ts`, `_shared/recurring-jobs/invoice.ts` | Stripe PaymentIntents/Checkout with `transfer_data.destination` = the business's connected account | Customer pays; Stripe routes to the connected account; platform is in the Stripe-Connect flow. No `application_fee` was found in these files. | Money-transmission / payment-facilitator analysis of the Connect model, agent-of-payee positions | **Not gated.** Gating would stop all card payments; counsel decision (section 3). |
| 6 | `payment-plan-actions`, `payment-plan-pay`, `payment-plan-runner`, `_shared/paymentPlans/*` | Contractor-offered instalment plans, auto-charge, late fees | Business is creditor; Vireek schedules and charges via Stripe | Whether instalments with late fees are consumer credit/finance-charge arrangements in a given state | **Not gated.** Open decision. |
| 7 | `20270402000000_gift_cards.sql`, `wallet-issue` (gift-card passes) | Coded, expiring stored-value gift cards and store credit with a ledger | Business-issued stored value; no Vireek-held funds seen | Stored-value / gift-card statutes, unclaimed-property, expiry rules | **Not gated.** Open decision. |
| 8 | `pay-by-bank-actions`, `20271115000000_pay_by_bank.sql` | Enables ACH capability on the connected account | Stripe ACH | Same as row 5 | **Not gated.** |
| 9 | `bank-connect`, `bank-sync`, `bank-webhook`, `payroll-*` | Read-style data connectors (not read in depth) | Not verified | Data-aggregation terms; confirm no funds movement | **Not gated.** Not inspected in depth. |
| 10 | `home_capital_underwriting` migration, `src/lib/homeCapitalUnderwriting.ts` | Home risk/maintenance-budget analytics. Despite the name it makes no credit decision (no applicant data, no offers) | None | Likely none; confirm marketing claims avoid "underwriting" language | **Not gated.** |
| 11 | Escrow | **No escrow code, table or doc exists** (searched `src`, `supabase`, `services`, `packages`, `docs`) | n/a | Escrow agent licensing varies by state and by what is held | Reserved capability `escrow`, default blocked. CI test fails if any file mentions escrow without referencing the gate. |

Not covered by this audit: mobile apps, `services/`, `packages/`, Cloudflare worker, third-party contracts, and any production data/configuration.

## 2. Control model (what was added)

`public.licensing_gate` — one row per capability: `licensing_confirmed` (default false), `kill_switch`, `counsel_ref`, confirmer + timestamp. A CHECK makes `licensing_confirmed = true` impossible without counsel ref, confirmer and timestamp. Writes only via staff RPCs; every change lands in append-only `licensing_gate_audit`.

| Staff RPC | Purpose |
|---|---|
| `staff_licensing_gate_list()` | See all capabilities |
| `staff_licensing_gate_set(capability, confirmed, counsel_ref, reason)` | Confirm / un-confirm (reason ≥ 8 chars; counsel ref required to confirm) |
| `staff_licensing_kill_all(reason)` | Kill every capability immediately |
| `staff_licensing_resume(capability, reason)` | Clear one kill switch (does not confirm licensing) |

Fail-closed behaviour: unknown capability, unreadable gate, kill switch or unconfirmed licensing all mean "not allowed". Pay is blocked only in `live` mode (sandbox moves no money).

## 3. Open decisions for the owner

1. **Is legacy BNPL (row 1) already live for any tenant?** If yes, it stops at deploy until counsel confirms and staff run `staff_licensing_gate_set('bnpl_legacy', true, '<counsel ref>', '<reason>')`.
2. Rows 4–8: should any of them get a gate? Gating row 5 would halt all card payments, so it needs counsel input first.
3. Which states are served today? Supply the list so counsel can fill the matrix below.
4. No UI for the gate exists; staff use the RPCs (SQL editor or a future staff page).

## 4. Counsel fill-in matrix (per capability × state served)

| Capability | State | Licence / registration required? | Evidence (counsel ref) | Reviewed on |
|---|---|---|---|---|
| bnpl_legacy | TODO(owner) | TODO(counsel) | TODO(counsel) | TODO(counsel) |
| financing_partners | TODO(owner) | TODO(counsel) | TODO(counsel) | TODO(counsel) |
| pay_instant_payouts / pay_earned_wage_access / pay_spend_cards / pay_capital | TODO(owner) | TODO(counsel) | TODO(counsel) | TODO(counsel) |
| escrow | TODO(owner) | TODO(counsel) | TODO(counsel) | TODO(counsel) |

## 5. Go-live checklist (per capability)

1. Counsel confirms licensing for every state served; record the reference.
2. Existing product gates are also satisfied (fin_gate region rule / pay disclosures reviewed and agreement ref).
3. `staff_licensing_gate_set(...)` with the counsel reference.
4. Verify in staging: gate closed → request refused; gate open → request proceeds; `staff_licensing_kill_all` → refused again.
5. Record a kill-switch drill (see `docs/RELEASE_SAFETY.md`).
