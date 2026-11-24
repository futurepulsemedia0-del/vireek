# AI liability matrix — who is responsible for what

Status: **working draft for counsel. Nothing here is legal advice, a contract term, or a statement about what any law requires.** Every allocation of responsibility below is a proposal **[COUNSEL]** until counsel confirms it and the customer terms say the same thing. Unverified facts are marked **[VERIFY]**.

Scope: the AI voice assistant's two commitments that carry money or promise risk — **stating a price** and **committing a visit time**. Controls are implemented in `supabase/functions/_shared/governance/commitThresholds.ts` and `supabase/migrations/20290311000000_ai_commit_controls.sql`. Other AI behaviour (SMS auto-reply, estimate agents, agent-caller quotes) is **not** covered yet; see §5.

## 1. What the control does (verified in the code)

| Situation | Result |
|---|---|
| Mode `off` | AI behaves as before. Nothing is recorded. The owner chose this; the change is in the policy history. |
| Mode `shadow` (default) | AI behaves as before. Each price or time it commits is audited, and a breach is flagged "would have held". |
| Mode `enforce`, inside every limit | AI commits. The decision and the policy that applied are audited. |
| Mode `enforce`, above a limit, or the amount/time cannot be verified | AI does **not** commit. It tells the caller it is an automated assistant that cannot confirm this, takes details, and a **pending approval** appears in the existing Agent Governance queue. |
| Policy cannot be read (not "table missing") | Treated as `enforce` with default limits. |
| Hold record cannot be written in `enforce` | Commitment is still blocked. |

After an owner approves a held item, **nothing is executed automatically**. Staff book or quote manually. Approval is an authorisation record, not an action.

## 2. Responsibility allocation (proposal) [COUNSEL]

| Topic | Vireek (platform) | Customer (the service business / account owner) | Caller / end customer |
|---|---|---|---|
| Building and operating the control as described in §1 | Responsible | — | — |
| Choosing the mode and the thresholds | Provides defaults, marked [VERIFY] with the owner | Responsible. Leaving `off` or `shadow` means the AI may commit any amount | — |
| Accuracy of the price book the AI reads | — | Responsible | — |
| The AI stating a price that differs from the price book | Responsible for the verification layer (`ai-core/priceEnforcement.ts`) [VERIFY scope] | Responsible for reviewing flagged calls | — |
| Reviewing and deciding held items in a timely way | Provides the queue | Responsible. Unreviewed items are not honoured | — |
| Honouring a price or time the AI committed inside the limits | — | **Open question [COUNSEL]** — likely the customer toward the caller | May rely on what it was told [COUNSEL] |
| Wording of the customer-facing disclosure | Supplies default text | Responsible for any custom text | — |
| That the caller knows it is speaking to an AI | See `voice-consent-and-ai-disclosure.md` (start-of-call disclosure); this control adds the in-the-moment disclosure when it cannot confirm | Responsible for local disclosure rules [COUNSEL] | — |
| Personal data in held items (name, phone, address) | Processor role, tenant-scoped storage [COUNSEL] | Controller role [COUNSEL] | — |

## 3. Customer-visible disclosure

When a commitment is held the assistant is instructed to say, in its own words and the caller's language, the substance of the tenant's text, or by default: *"You are speaking with an automated AI assistant. It is not able to confirm this on its own, so a member of the team will review it and confirm it with you."* **[COUNSEL]** must review the default text and any local-language versions before it is relied on. The exact text that applied is stored on each audit row. The assistant is told never to reveal limits or approval rules.

Not yet built: a disclosure shown to the caller in writing (SMS or confirmation page). Spoken only.

## 4. Audit trail

Each evaluation writes one row to `agent_action_log` (`ai_commit_price` / `ai_commit_schedule`): the proposed amount or time, every breached rule with limit and actual value, the full policy that applied, the disclosure text, and a correlation ID so a retried tool call never creates a second row. Policy changes are in `ai_commit_policy_changes` (who, when, old and new). Retention period for these rows is undecided **[COUNSEL]**.

## 5. Known gaps (not covered by this control)

| Gap | Why | What would close it |
|---|---|---|
| Price-First Playbook replies (`tryPricePolicyReply`) speak amounts without a structured value | Amounts are in prose; extracting them would be a guess | A structured amount returned by `lookupPolicyReply` |
| `agentQuote` (AI-agent callers), SMS auto-reply, `estimate-recovery-agent`, `field-estimate` | Not inspected for this task | Review each commit point; wire `gateAiCommit` |
| Execution after approval | Needs a verified `jobs` contract and capacity re-check | A separate, reviewed executor |
| Default thresholds | Product decision | Owner confirms values [VERIFY] |
| Currency | Thresholds are minor units of the account's currency | Owner sets per account |

## 6. Verification status

Unit tests of the decision logic and of the migration's security shape ran and passed. The migration passed the repository's strict linter. The SQL itself has **not** been executed against a database, the pgTAP file has **not** been run, and nothing was tested on a live call.
