# Dark-pattern checklist (signup, billing, cancellation, upsell)

Checked mechanically by `npm run lint:dark-patterns` (`scripts/check-dark-patterns.mjs`, rules in `scripts/lib/darkPatterns.mjs`, tests `npm run test:scripts:dark-patterns`). Reviewed exceptions live in `scripts/dark-patterns.allowlist.json` and each needs a written reason. The script is a heuristic: a clean run means none of the *mechanical* patterns below were found, not that a flow is fair. New or changed flows still need a human pass against this list.

Legal status: this is a product-design standard, not legal advice. [COUNSEL] confirm against the rules that apply where Vireek sells (US FTC negative-option / "click to cancel" rules and state auto-renewal laws, EU/UK consumer law and the EU DSA dark-pattern ban, etc.). [VERIFY] the current status and scope of each before citing it externally.

| ID | Rule | Automated | How to check by hand |
|---|---|---|---|
| DP-01 | Nothing that costs money, shares data or sends marketing is pre-selected. Terms box starts unchecked. | yes (flow files: any pre-checked box; elsewhere: option names like marketing/consent/addon/autoCharge) | Open every form with a fresh account |
| DP-02 | No confirmshaming: the decline option is neutral ("No thanks", "Not now"), never insulting or guilt-tripping. | yes (all `src`) | Read both buttons aloud; would you be embarrassed to click the one you want? |
| DP-03 | Cancelling is self-serve, reachable from Billing and Plans, never "contact support". | yes | Count clicks from Billing to "cancellation scheduled" |
| DP-04 | No false urgency or scarcity. Only real, dated deadlines (trial end) are shown. | yes (flow files) | Compare every deadline to data in the database |
| DP-05 | The cancel survey is optional and has a visible "Skip and cancel now". | yes | Cancel with the survey empty |
| DP-06 | Cancelling takes no more steps than signing up (max 3 steps). | yes (step type) | Time both |
| DP-07 | Cancel and keep buttons are equally easy to see and reach (size >= 44px, contrast, order not reversed to hide cancel). | no | Visual review |
| DP-08 | Price, renewal date, billing interval and what happens on cancel are shown next to the buy button (`RenewalDisclosure`). | no | Visual review |
| DP-09 | Save offers are real, capped and honest (server-filtered); no offer is invented per visit. | no | Review `churn_save` config |
| DP-10 | Default billing cycle is shown with both prices; no hidden fees at checkout. | no | Compare pricing page to Stripe checkout |

## Audit of this repo (uploaded snapshot vireek-main__9_.zip)

| # | Flow | Finding | Rule | Status |
|---|---|---|---|---|
| 1 | Plans page, Free card | Said "To cancel a paid subscription, contact support." Self-serve cancel exists; the page hid it. | DP-03 | **Fixed**: now a "Cancel subscription" link to `/dashboard/billing/cancel` |
| 2 | Cancel survey | Reason was required (red asterisk, blocking error), and Continue could not be pressed without it. The existing tests already specified "optional" + "Skip and cancel now". | DP-05 | **Fixed** (see note on broken file below) |
| 3 | Payment plans, create dialog | "Auto-charge the card on each due date" started checked. | DP-01 | **Fixed**: starts unchecked |
| 4 | Payment plans, create dialog | "Send the approval link now" starts checked. Staff-side convenience, no charge or data share. | DP-01 | Reviewed, allowlisted with reason |
| 5 | Pricing page | Default billing cycle comes from experiment `pricing_default_billing` (can default to annual). Both prices and "billed $X/year" are displayed. | DP-10 | Reviewed, OK. [VERIFY] the experiment never hides the monthly price |
| 6 | Signup | Terms box starts unchecked, no marketing opt-in, no urgency copy. "No credit card required" copy. | DP-01/04 | OK. [VERIFY] the claim is true for the live trial |
| 7 | Cancel confirm step | Neutral wording, "Keep my subscription" and "Cancel subscription" both visible, no shaming. | DP-02/07 | OK |
| 8 | Trial banner / upgrade banner | Countdown comes from `trial_ends_at` only; no fake scarcity found. | DP-04 | OK |
| 9 | Voice membership pitch (`pitch_membership`) | Not a UI flow; offers the configured plan once and records a decline without re-asking. [VERIFY] prompt wording of the live assistant. | - | Not covered by the script |
| 10 | Data governance consent form | A `granted` select defaults to "granted". Operator ledger entry, not a consumer opt-in. | DP-01 | Reviewed, left as is. [COUNSEL] |

### Code integrity note
`src/pages/CancelSubscriptionPage.tsx` in the uploaded snapshot did not parse (a duplicated `Continue</Button>` and a garbled "Back" button), and `CancelSubscriptionPage.test.tsx` contained an orphaned test body. Both were repaired. Check the live files before applying: if yours already parse, only apply the behavioural edits.

## Known gaps
- Copy in the pages above is plain English, not yet routed through i18n (the pages were already like this). RTL is unaffected by these edits.
- DP-07..DP-10 are manual. The mobile/visual side of DP-07 is covered by the existing touch-target audit (`npm run a11y:targets`).
- The script scans `src`; Stripe-hosted checkout, emails and the Vapi assistant prompt are out of its reach.
