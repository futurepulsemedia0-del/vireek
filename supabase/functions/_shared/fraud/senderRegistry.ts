// supabase/functions/_shared/fraud/senderRegistry.ts
//
// Classification of EVERY code path that can reach Twilio / Vapi. It is data, not behaviour, and it is enforced by
// senderRegistry.test.ts: a new file that calls a provider (or the raw deliver.ts senders) without being listed here
// fails CI, and every customer_outbound entry must contain the guard marker named in `guard`.
//
// Paths are relative to supabase/functions/.
//
//   customer_outbound  customer-driven outbound SMS / calls (campaigns, follow-ups, workflow steps, speed-to-lead, power
//                      dialer, softphone / click-to-call, customer notifications). GUARDED: guardOutbound() (budget,
//                      kill switches, verification, destination policy, purpose rules) or, where noted, guardDestination().
//   provider_adapter   thin provider client. Never called directly for a customer; its callers are guarded.
//   in_call_helper     acts on a call that already exists (transfer, interpreter, live control, PCI pause, bridge agent leg).
//                      EXEMPT: no new customer-facing spend and the budget was reserved when the call started.
//   system_internal    platform / staff traffic: OTP, owner + on-call + technician alerts, probes, audits, erasure, benchmark.
//                      EXEMPT: not customer-driven, never counts against a customer's plan, must never be blocked by caps.

export type SenderClass = "customer_outbound" | "provider_adapter" | "in_call_helper" | "system_internal";

export interface SenderEntry {
  path: string;
  class: SenderClass;
  /** Why this classification (and, for exemptions, why no guard). */
  reason: string;
  /** customer_outbound only: a string that must appear in the file (proof that the guard call is wired). */
  guard?: string;
  /** customer_outbound only: the guard purpose(s) the sender uses. */
  purpose?: string;
}

const G = "gateCustomerOutbound";
const D = "gateDestinationOnly";
const GS = "sendGuardedSms";

export const SENDER_REGISTRY: SenderEntry[] = [
  // ---- funnels (cover every caller of sendCompliantSms / sendGatedSms) ------------------------------------------------
  { path: "_shared/messaging/sendSms.ts", class: "customer_outbound", guard: G, purpose: "caller's purpose / fraudPurpose (default service)", reason: "sendCompliantSms: the single A2P SMS funnel (~50 callers: campaigns, follow-ups, workflows, surveys, summaries, inbox, lead marketplace, rich messaging, operator agent). Guard runs after A2P / DNC / quiet hours, immediately before Twilio." },
  { path: "_shared/messaging/gatedSend.ts", class: "customer_outbound", guard: G, purpose: "service (default) | marketing | emergency", reason: "sendGatedSms + sendGuardedSms: plain customer SMS (quiet-hours gated or not). Guard immediately before deliver.sendSms." },
  { path: "deferred-message-dispatcher/index.ts", class: "customer_outbound", guard: GS, purpose: "the deferred row's purpose", reason: "Sends queued (quiet-hours) messages. Guarded at the real send moment; a blocked row is parked at retryAt or failed, never retried on the short backoff." },

  // ---- customer SMS senders that bypassed the funnels (now routed through sendGuardedSms) -----------------------------
  { path: "issue-refund/index.ts", class: "customer_outbound", guard: GS, purpose: "service", reason: "Refund notice to the customer." },
  { path: "send-signature-request/index.ts", class: "customer_outbound", guard: GS, purpose: "service", reason: "Signature request link to the signer." },
  { path: "send-payment-reminders/index.ts", class: "customer_outbound", guard: GS, purpose: "service", reason: "Payment reminder to the customer." },
  { path: "financing-create-offer/index.ts", class: "customer_outbound", guard: GS, purpose: "service", reason: "Financing offer link to the customer." },
  { path: "membership-lifecycle-agent/index.ts", class: "customer_outbound", guard: GS, purpose: "service", reason: "Membership renewal / pipeline customer messages (the pipeline passes the owning account to the sender)." },
  { path: "_shared/recurring-jobs/invoice.ts", class: "customer_outbound", guard: GS, purpose: "service", reason: "Recurring-job invoice link to the customer." },
  { path: "_shared/paymentPlans/charge.ts", class: "customer_outbound", guard: GS, purpose: "service", reason: "notifyCustomer(): payment-plan, bank-payment and installment customer SMS (owner resolved from the contact or the pay link)." },
  { path: "self-healing-orchestrator/index.ts", class: "customer_outbound", guard: GS, purpose: "service", reason: "Delay / reschedule updates to customers. Its technician alert (raw sendSms) is an internal staff message." },
  { path: "emergency-ops-broadcast/index.ts", class: "customer_outbound", guard: GS, purpose: "service (customers audience only)", reason: "Customer audience is guarded; team / on-call audiences are internal staff alerts and stay raw." },

  // ---- customer-driven calls ---------------------------------------------------------------------------------------------
  { path: "_shared/voice-engine/vapiEngine.ts", class: "provider_adapter", guard: "maxDurationSeconds", reason: "Vapi adapter. Carries assistantOverrides.maxDurationSeconds; the only caller (outbound-dialer) runs the guard first." },
  { path: "outbound-dialer/index.ts", class: "customer_outbound", guard: G, purpose: "service (appointment reminders) | marketing", reason: "Queued outbound AI calls via VapiEngine.startCall. Blocked calls are parked at retryAt or failed, never left queued." },
  { path: "followup-agent-dispatcher/index.ts", class: "customer_outbound", guard: G, purpose: "service (reminders) | marketing", reason: "Follow-up SMS (via sendCompliantSms) and direct Vapi calls (legacy + governed path)." },
  { path: "workflow-engine-executor/index.ts", class: "customer_outbound", guard: G, purpose: "service (job / invoice entities) | marketing", reason: "Workflow SMS (via sendCompliantSms) and Vapi call steps." },
  { path: "_shared/speed-to-lead/runtime.ts", class: "customer_outbound", guard: G, purpose: "service", reason: "Instant call-back to a lead that asked to be contacted." },
  { path: "dialer-call/index.ts", class: "customer_outbound", guard: G, purpose: "marketing", reason: "Power dialer: budget reserved for the contact call; the agent leg is Twilio-capped (TimeLimit)." },
  { path: "call-bridge-voice/index.ts", class: "customer_outbound", guard: D, purpose: "destination policy + plan duration cap", reason: "TwiML <Dial> hops (dialer contact leg, proxy customer leg, proxy forward). Settles reservations with the real duration." },
  { path: "_shared/pbx/runtime.ts", class: "customer_outbound", guard: G, purpose: "service (softphone outbound) | destination-only (forward / consult legs)", reason: "createLeg(): external-number legs." },
  { path: "browser-extension/index.ts", class: "customer_outbound", guard: G, purpose: "service (lead) | marketing", reason: "Click-to-call bridge. No status callback exists, so its reservation is not settled with the real duration (documented limitation)." },
  { path: "first-call-start/index.ts", class: "customer_outbound", guard: D, purpose: "destination policy + plan duration cap", reason: "Onboarding demo call / ready-SMS to the number the owner typed. Destination-only on purpose: the demo exists for UNVERIFIED new accounts and is already rate limited (3/h, 8/day)." },
  { path: "voice-studio-test-call/index.ts", class: "customer_outbound", guard: D, purpose: "destination policy + min(45 s, plan cap)", reason: "Owner test call to the owner's own escalation number; destination-only because escalation_phone is owner-editable." },

  // ---- exempt: in-call helpers ----------------------------------------------------------------------------------------------
  { path: "csr-call-transfer/index.ts", class: "in_call_helper", reason: "Transfers a live call to a human. No new customer spend; transfer legs keep their existing limits." },
  { path: "live-call-control/index.ts", class: "in_call_helper", reason: "Live control (transfer / inject) of a call that already holds a reservation." },
  { path: "interpreter/index.ts", class: "in_call_helper", reason: "Three-way interpreter leg added to a live call." },
  { path: "proxy-call-bridge/index.ts", class: "in_call_helper", reason: "Rings the technician's own stored phone; the CUSTOMER leg is dialed (and guarded) in call-bridge-voice." },
  { path: "_shared/pci/ports.ts", class: "in_call_helper", reason: "PCI pause / resume recording on a live call." },
  { path: "_shared/pci/twilio.ts", class: "in_call_helper", reason: "PCI pause / resume recording on a live call." },

  // ---- exempt: provider clients / lookups ---------------------------------------------------------------------------
  { path: "_shared/notify/deliver.ts", class: "provider_adapter", reason: "Raw sendSms / sendVoiceCall. Customer traffic must use sendGuardedSms / sendGatedSms / sendCompliantSms; this adapter is for staff and OTP messages." },
  { path: "_shared/pbx/twilio.ts", class: "provider_adapter", reason: "Twilio REST client used by pbx runtime / bridges (the callers above are guarded)." },
  { path: "_shared/call-bridge/logic.ts", class: "provider_adapter", reason: "Pure TwiML builder (dialTwiml, now with timeLimit); its only callers are call-bridge-voice, which is guarded." },
  { path: "_shared/agent-run/twilioLookup.ts", class: "provider_adapter", reason: "Read-only Twilio message lookup (no send)." },

  // ---- exempt: system / internal ---------------------------------------------------------------------------------------------
  { path: "auth-send-sms-hook/index.ts", class: "system_internal", reason: "Auth OTP: guarded by fraud/otpFlow (OTP lane), not by this adapter." },
  { path: "voice-account/index.ts", class: "system_internal", reason: "Phone-setup OTP to the owner. FINDING: not routed through the OTP guard in this snapshot." },
  { path: "voice-call/index.ts", class: "system_internal", reason: "Call-verification OTP (raw sendSms); its customer-visible SMS already goes through sendCompliantSms. FINDING: OTP send not guard-routed." },
  { path: "vapi-webhook/index.ts", class: "system_internal", reason: "Inbound call handling: owner / forwarding alerts only; its inbound duration cap + settleCall are wired here." },
  { path: "synthetic-probe/index.ts", class: "system_internal", reason: "Platform synthetic probe against our own numbers." },
  { path: "_shared/voice-resilience/adapters.ts", class: "system_internal", reason: "Provider health probes." },
  { path: "_shared/audit/providers.ts", class: "system_internal", reason: "Provider audit (read-only API calls)." },
  { path: "_shared/audit/script.ts", class: "system_internal", reason: "Provider audit helper." },
  { path: "_shared/compliance/providerErasure.ts", class: "system_internal", reason: "Data-erasure requests to providers (deletes, never sends)." },
  { path: "_shared/ovb/runtime.ts", class: "system_internal", reason: "Open Voice Benchmark: platform-operated (no tenant / plan on its rows), Vireek-paid fixed 300 s cap, calls vendor agent numbers." },
  { path: "_shared/fraud/alerts.ts", class: "system_internal", reason: "Fraud alerts to platform staff." },
  { path: "_shared/safety/runtime.ts", class: "system_internal", reason: "Technician safety check-ins and supervisor all-clears (staff)." },
  { path: "business-immune-scan/index.ts", class: "system_internal", reason: "Owner alert." },
  { path: "commitment-monitor-tick/index.ts", class: "system_internal", reason: "Owner alert." },
  { path: "detect-service-recovery-signals/index.ts", class: "system_internal", reason: "Owner escalation page." },
  { path: "emergency-mode-activate/index.ts", class: "system_internal", reason: "On-call technician alert." },
  { path: "emergency-network-orchestrator/index.ts", class: "system_internal", reason: "Staff / partner alerts." },
  { path: "escalate-emergency/index.ts", class: "system_internal", reason: "On-call escalation to team members (must never be capped)." },
  { path: "escalation-tick/index.ts", class: "system_internal", reason: "On-call escalation to team members (must never be capped)." },
  { path: "outbound-queue-builder/index.ts", class: "system_internal", reason: "On-call escalation to team members (must never be capped)." },
  { path: "franchise-royalty-issue/index.ts", class: "system_internal", reason: "Franchise owner notice." },
  { path: "mutual-aid-notify/index.ts", class: "system_internal", reason: "Business-to-business mutual-aid notice to the owner." },
  { path: "notification-router/index.ts", class: "system_internal", reason: "Routes owner / team notifications by rule (recipients are staff)." },
  { path: "weather-surge-check/index.ts", class: "system_internal", reason: "Team alert." },
];

/** Regexes that identify a file as able to reach a provider. Used by the coverage test. */
export const PROVIDER_PATTERNS: RegExp[] = [
  /api\.twilio\.com\/2010-04-01\/Accounts/,
  /api\.vapi\.ai\/call/,
  /VAPI_CALL_URL/,
  /twilioApi\(\s*['"`](?:Calls|Messages)\.json/,
  /\b(?:Calls|Messages)\.json/,
  /await\s+(?:sendSms|sendVoiceCall)\(/,
  /\.startCall\(/,
  /\bdialTwiml\(/,
];
