// src/test/planEnforcement/registry.ts
//
// THE coverage registry. Pure data, reviewed by humans. Three rules are enforced by planEnforcementCoverage.test.ts:
//
//  1. Every file under supabase/functions that can place a call, send a message, clone a voice or touch the
//     Twilio host (see scan.ts) MUST appear here, either in SENDER_REGISTRY (a customer-driven sender that must
//     be guarded) or in EXEMPT_SENDERS (with a reason). A new, unlisted sender fails CI.
//  2. A SENDER_REGISTRY entry with `gap: null` MUST call guardOutbound()/guardDestination(). An entry with a gap id
//     is a KNOWN, TICKETED hole: the test insists it is still unguarded, so the day someone wires the guard the
//     test fails until the gap marker is removed. Gaps can only shrink.
//  3. Reasons and tickets must be real sentences. "TODO" does not pass.
//
// TICKET IDS ARE PLACEHOLDERS (PLAN-ENF-nnn). They exist so every "no" in docs/plan-enforcement-matrix.md has a
// stable handle; create the matching issues in your tracker and keep the ids.

export type GapId =
  | 'GAP-W1' // outbound plan caps / verification / kill switches exist (guard.ts) but no sender calls them
  | 'GAP-I1' // free-plan inbound minute hard stop exists (fraud/inbound.ts) but vapi-webhook never calls it
  | 'GAP-S1' // seats not enforced
  | 'GAP-L1' // locations not enforced
  | 'GAP-N1' // PLAN_LIMITS.maxNumbers is never read
  | 'GAP-C1' // no concurrent-call limit exists
  | 'GAP-M1' // no monthly SMS limit exists (only a daily one)
  | 'GAP-R1' // transcript / recording retention is not plan-driven
  | 'GAP-F1' // plan-gated features (dispatch / CRM / recording / analytics / API) have no server-side plan check
  | 'GAP-E1' // module entitlements are never derived from the plan (the "plan sync job" does not exist)
  | 'GAP-G1' // grandfathering: customer.subscription.updated overwrites stored minutes_included
  | 'GAP-O1' // standard-plan overage rate is display-only; nothing meters or invoices it server-side
  | 'GAP-V1' // voice-clone plan sources disagree (planLimits vs voice-consent vs pricing)
  | 'GAP-P1' // SIEM plan gate disagrees with pricing (Business allowed, pricing says Enterprise)
  | 'GAP-E3' // sendCompliantSms has no emergency lane (A2P / DNC gates run before purpose is looked at)
  | 'GAP-E4' // owner setting allowEmergencyOverride=false can defer emergency messages
  | 'GAP-T1'; // Stripe trialing accounts are guarded with FREE caps (decision needed)

export interface KnownGap {
  id: GapId;
  ticket: string;
  title: string;
  /** What is true today, in one or two sentences. */
  effect: string;
  /** The smallest change that closes it. Documentation only. */
  fix: string;
}

export const KNOWN_GAPS: Readonly<Record<GapId, KnownGap>> = {
  'GAP-W1': {
    id: 'GAP-W1', ticket: 'PLAN-ENF-001',
    title: 'guardOutbound() is not called by any customer-driven sender',
    effect: 'Daily call/SMS caps, spend caps, max call length, outbound verification, kill switches and the voice-clone gate are implemented and unit-correct, but production senders never invoke them.',
    fix: 'Call guardOutbound() before each registered sender (purpose "emergency" for hand-offs and dispatch). Wire the shared choke points first: _shared/messaging/sendSms.ts, _shared/notify/deliver.ts, _shared/voice-engine/vapiEngine.ts, _shared/pbx/runtime.ts.',
  },
  'GAP-I1': {
    id: 'GAP-I1', ticket: 'PLAN-ENF-002',
    title: 'Free-plan inbound minute hard stop is dead code',
    effect: 'checkInboundAllowance()/exhaustedResponse() are exported but nothing calls them; the vapi-webhook assistant-request handler does not stop a Free account whose minutes are used.',
    fix: 'Call checkInboundAllowance() in the vapi-webhook assistant-request path and return exhaustedResponse() when allowed is false.',
  },
  'GAP-S1': {
    id: 'GAP-S1', ticket: 'PLAN-ENF-003',
    title: 'Seat limits are display text only',
    effect: 'pricing.ts says "2 seats", "5 seats", "15 seats"; no invite / profile-creation path checks it.',
    fix: 'Add a seat limit to a single plan-limits table and check it in the invite RPC (grandfather accounts already over the limit: block adds, never lock out).',
  },
  'GAP-L1': {
    id: 'GAP-L1', ticket: 'PLAN-ENF-004',
    title: 'Location limits are display text only',
    effect: 'pricing.ts says "1 location" / "Up to 3 locations"; nothing enforces it.',
    fix: 'Same table and grandfathering rule as seats, checked where a location is created.',
  },
  'GAP-N1': {
    id: 'GAP-N1', ticket: 'PLAN-ENF-005',
    title: 'PLAN_LIMITS.maxNumbers is never read',
    effect: 'The per-plan phone-number cap exists as data only (src/lib/dynamicNumbers.ts has an unrelated pool limit).',
    fix: 'Check it where numbers are purchased / assigned.',
  },
  'GAP-C1': {
    id: 'GAP-C1', ticket: 'PLAN-ENF-006',
    title: 'No concurrent-call limit exists for any plan',
    effect: 'Neither pricing nor code defines one; concurrency is bounded only by the voice provider account.',
    fix: 'Decide the per-plan value first (product decision), then enforce it in assistant-request.',
  },
  'GAP-M1': {
    id: 'GAP-M1', ticket: 'PLAN-ENF-007',
    title: 'No monthly SMS limit exists',
    effect: 'Only dailySms exists (itself unwired, see GAP-W1). There is no per-month figure.',
    fix: 'Decide the per-plan value, add it next to dailySms, enforce in guardOutbound().',
  },
  'GAP-R1': {
    id: 'GAP-R1', ticket: 'PLAN-ENF-008',
    title: 'Retention is per-tenant policy, not per plan',
    effect: 'pricing.ts promises 7-day transcript history on Starter and unlimited on Professional+; data-retention-sweep reads data_retention_policies rows and never looks at the plan.',
    fix: 'Seed data_retention_policies from the plan on plan change, or have the sweep clamp to the plan value.',
  },
  'GAP-F1': {
    id: 'GAP-F1', ticket: 'PLAN-ENF-009',
    title: 'dispatch / CRM / recording / analytics / API have no server-side plan check',
    effect: 'COMPARE_VALUES marks them plan-gated; no edge function checks the plan for them. Note: the emergency hand-off lane must stay ungated on every plan (guard.ts), so "dispatch" needs a product decision on what exactly is gated.',
    fix: 'Express each as an entitlement module (GAP-E1) or a plan check at its entry point.',
  },
  'GAP-E1': {
    id: 'GAP-E1', ticket: 'PLAN-ENF-010',
    title: 'Module entitlements are not derived from the plan',
    effect: 'Entitlements are granted manually by staff; the plan-sync job referenced in the migration does not exist. Two parallel systems also exist (account_module_entitlements via requireEntitlement, account_modules via requireModule).',
    fix: 'Write source = "plan" rows from the Stripe webhook / plan change (never overwriting source = "override"), and converge on one system.',
  },
  'GAP-G1': {
    id: 'GAP-G1', ticket: 'PLAN-ENF-011',
    title: 'Grandfathered minutes_included is overwritten by customer.subscription.updated',
    effect: 'The handler writes minutes_included = minutesForPlan(planId) on every subscription update, so an old-Starter account loses its stored allowance on the next card update / trial end / metadata change.',
    fix: 'Only write minutes_included when profiles.plan actually changes (read the row first), or never write it from this event.',
  },
  'GAP-O1': {
    id: 'GAP-O1', ticket: 'PLAN-ENF-012',
    title: 'Standard-plan overage is not metered or invoiced by code in this repo',
    effect: 'The $/min overage text is parsed for UI and cost analytics only; only results-plan-bill reports metered usage. Paid accounts are never blocked, so overage is either billed outside this repo or not billed at all.',
    fix: 'Confirm where overage is invoiced; if nowhere, report minutes over minutes_included to a Stripe meter.',
  },
  'GAP-V1': {
    id: 'GAP-V1', ticket: 'PLAN-ENF-013',
    title: 'Voice-clone eligibility is defined three different ways',
    effect: 'planLimits.allowVoiceClone: Starter and up. voice-consent CLONE_PLANS: Business and Enterprise. pricing.ts: "Custom-trained voice model" listed under Enterprise. Starter and Professional are blocked in practice, contradicting planLimits.',
    fix: 'Pick one rule, put it in one module, and import it in voice-consent, guard.ts and pricing.',
  },
  'GAP-P1': {
    id: 'GAP-P1', ticket: 'PLAN-ENF-014',
    title: 'SIEM streaming is allowed on Business, pricing says Enterprise',
    effect: 'SIEM_PLANS = business + enterprise; pricing.ts lists "Audit logs & advanced access controls" under Enterprise only.',
    fix: 'Decide the intended plan, then align SIEM_PLANS or pricing.ts.',
  },
  'GAP-E3': {
    id: 'GAP-E3', ticket: 'PLAN-ENF-015',
    title: 'sendCompliantSms has no emergency lane',
    effect: 'The A2P approval and DNC checks run before any purpose is examined, so an emergency / dispatch text routed through it can be refused. Emergency paths today use the raw notify/deliver.ts sender, which is why they are not blocked.',
    fix: 'When the guard is added to sendCompliantSms, keep purpose "emergency" ahead of the A2P / DNC / plan checks, as guardOutbound() does.',
  },
  'GAP-E4': {
    id: 'GAP-E4', ticket: 'PLAN-ENF-016',
    title: 'Owner setting can defer emergency messages',
    effect: 'With quiet hours enabled and allowEmergencyOverride = false, an emergency message inside the quiet window is deferred, not sent.',
    fix: 'Ignore allowEmergencyOverride for purpose "emergency", or force it on in the settings validator.',
  },
  'GAP-T1': {
    id: 'GAP-T1', ticket: 'PLAN-ENF-017',
    title: 'Trialing accounts get Free caps from the fraud guard',
    effect: 'fraud_guard_context returns the paid plan only for subscription_status active or past_due; "trialing" falls back to free. Pricing advertises a 14-day trial of the paid plan.',
    fix: 'Product decision: keep (anti-farming) and say so on the pricing page, or include trialing.',
  },
};

// ---------------------------------------------------------------------------
// Senders (paths relative to supabase/functions)
// ---------------------------------------------------------------------------

export type SenderChannel = 'call' | 'sms' | 'clone';

export interface RegisteredSender {
  file: string;
  channel: SenderChannel;
  /** What it sends and who triggers it. */
  what: string;
  /** null = the file calls the guard today. A gap id = known, ticketed, still unguarded. */
  gap: GapId | null;
}

const W1 = 'GAP-W1' as const;

export const SENDER_REGISTRY: readonly RegisteredSender[] = [
  { file: '_shared/messaging/sendSms.ts', channel: 'sms', what: 'sendCompliantSms: the A2P customer SMS choke point (37 importers)', gap: null },
  { file: '_shared/notify/deliver.ts', channel: 'sms', what: 'raw Twilio SMS + voice call (58 importers; mixes owner alerts, emergency dispatch and customer texts)', gap: W1 },
  { file: '_shared/voice-resilience/adapters.ts', channel: 'sms', what: 'failover carrier adapters: Twilio call/SMS and Telnyx SMS', gap: W1 },
  { file: '_shared/richMessaging/sinch.ts', channel: 'sms', what: 'RCS / Apple Messages sender (Sinch Conversation API)', gap: W1 },
  { file: '_shared/voice-engine/vapiEngine.ts', channel: 'call', what: 'Vapi outbound engine used by outbound-dialer', gap: W1 },
  { file: 'outbound-dialer/index.ts', channel: 'call', what: 'campaign outbound AI calls (imports the voice engines)', gap: null },
  { file: 'first-call-start/index.ts', channel: 'call', what: 'first-call outbound AI call', gap: W1 },
  { file: 'workflow-engine-executor/index.ts', channel: 'call', what: 'workflow-triggered AI calls', gap: W1 },
  { file: 'followup-agent-dispatcher/index.ts', channel: 'call', what: 'follow-up AI calls', gap: W1 },
  { file: '_shared/speed-to-lead/runtime.ts', channel: 'call', what: 'speed-to-lead callback within 60 s of a web lead', gap: W1 },
  { file: 'csr-call-transfer/index.ts', channel: 'call', what: 'live-call transfer to a CSR (hand-off lane must stay open)', gap: W1 },
  { file: 'live-call-control/index.ts', channel: 'call', what: 'live-call control / forward (hand-off lane must stay open)', gap: W1 },
  { file: 'interpreter/index.ts', channel: 'call', what: 'three-way interpreter call', gap: W1 },
  { file: 'voice-studio-test-call/index.ts', channel: 'call', what: 'owner-triggered voice test call', gap: W1 },
  { file: 'dialer-call/index.ts', channel: 'call', what: 'power-dialer "Call" button (Twilio rings the agent, then the contact)', gap: W1 },
  { file: 'proxy-call-bridge/index.ts', channel: 'call', what: 'technician "Call customer" bridge', gap: W1 },
  { file: 'browser-extension/index.ts', channel: 'call', what: 'Chrome extension click-to-call', gap: W1 },
  { file: '_shared/pbx/runtime.ts', channel: 'call', what: 'PBX click-to-call / transfer legs (twilioApi Calls.json)', gap: W1 },
  { file: 'clone-voice/index.ts', channel: 'clone', what: 'ElevenLabs voice cloning (kind "clone" in the guard)', gap: W1 },
];

export interface ExemptSender {
  file: string;
  reason: string;
}

export const EXEMPT_SENDERS: readonly ExemptSender[] = [
  { file: '_shared/agent-run/twilioLookup.ts', reason: 'Read-only GET on the Messages list (delivery lookup). Sends nothing.' },
  { file: '_shared/pci/twilio.ts', reason: 'Updates or reads an ALREADY ACTIVE call (pause recording, recordings list). Creates no call and no message.' },
  { file: '_shared/pbx/twilio.ts', reason: 'Generic Twilio REST helper and TwiML utilities. It sends nothing itself; each twilioApi("Calls.json") caller is registered individually.' },
  { file: '_shared/audit/script.ts', reason: 'Pure payload builder for the audit call. The POST lives in _shared/audit/providers.ts.' },
  { file: '_shared/audit/providers.ts', reason: 'Missed-call audit funnel: separate product surface with its own phone policy and OTP controls in _shared/audit, not metered against a plan. Needs an owner decision (PLAN-ENF-018) on whether it should ever count against spend caps.' },
  { file: '_shared/ovb/runtime.ts', reason: 'Open Voice Benchmark: platform-owned benchmark calls run by cron or staff, not customer-driven.' },
  { file: 'synthetic-probe/index.ts', reason: 'Platform synthetic monitoring: Vireek dials its own target through the real AI path; probe faults are excluded from SLOs. Not customer-driven.' },
];

/** Min length for an exempt reason. Keeps "n/a" and "TODO" out. */
export const MIN_REASON_LENGTH = 40;

// ---------------------------------------------------------------------------
// Gap detectors: the patterns whose ABSENCE keeps a gap open (see gaps.ts). Each allow-list entry is a file that
// matches the pattern for an unrelated reason, with the reason spelled out.
// ---------------------------------------------------------------------------

export interface AbsenceProbe {
  gap: GapId;
  /** Directories scanned (.ts non-test sources, or .sql when `sql` is true). */
  dirs: readonly string[];
  sql?: boolean;
  pattern: RegExp;
  allow: Readonly<Record<string, string>>;
}

export const ABSENCE_PROBES: readonly AbsenceProbe[] = [
  {
    gap: 'GAP-S1', dirs: ['supabase/functions', 'src/lib'],
    pattern: /max_?seats|maxSeats|seat_?limit|seats_included/i,
    allow: {},
  },
  {
    gap: 'GAP-S1', dirs: ['supabase/migrations'], sql: true,
    pattern: /max_?seats|maxSeats|seat_?limit|seats_included/i,
    allow: {},
  },
  {
    gap: 'GAP-L1', dirs: ['supabase/functions', 'src/lib'],
    pattern: /max_?locations|maxLocations|location_?limit|locations_included/i,
    allow: { 'supabase/functions/_shared/listings/sync.ts': 'Google listing sync batch size, unrelated to plans' },
  },
  {
    gap: 'GAP-L1', dirs: ['supabase/migrations'], sql: true,
    pattern: /max_?locations|maxLocations|location_?limit|locations_included/i,
    allow: {},
  },
  {
    gap: 'GAP-N1', dirs: ['supabase/functions', 'src/lib'],
    pattern: /\bmaxNumbers\b/,
    allow: {
      'supabase/functions/_shared/fraud/planLimits.ts': 'the definition itself',
      'src/lib/dynamicNumbers.ts': 'unrelated number-pool limit of the dynamic number insertion feature',
    },
  },
  {
    gap: 'GAP-C1', dirs: ['supabase/functions'],
    pattern: /max_?concurrent|concurrentCalls|concurrent_calls|concurrency_?limit/i,
    allow: { 'supabase/functions/_shared/netsuite/engine.ts': 'NetSuite API concurrency, unrelated to telephony' },
  },
  {
    gap: 'GAP-C1', dirs: ['supabase/migrations'], sql: true,
    pattern: /max_?concurrent|concurrentCalls|concurrent_calls|concurrency_?limit/i,
    allow: {
      'supabase/migrations/20261201000000_capacity_exchange.sql': 'capacity exchange marketplace, unrelated to telephony',
      'supabase/migrations/20270120000000_capacity_exchange_liquidity_layer.sql': 'capacity exchange marketplace, unrelated to telephony',
    },
  },
  {
    gap: 'GAP-M1', dirs: ['supabase/functions', 'src/lib'],
    pattern: /sms_?per_?month|monthly_?sms|sms_?monthly|smsPerMonth|sms_?quota|sms_?included/i,
    allow: {
      'supabase/functions/_shared/results-plan/unitEconomics.ts': 'results-plan cost model, not an enforced limit',
      'src/lib/resultsPlan/unitEconomics.ts': 'results-plan cost model, not an enforced limit',
    },
  },
  {
    gap: 'GAP-R1', dirs: ['supabase/functions/data-retention-sweep'],
    pattern: /\bplan\b/i,
    allow: {},
  },
  {
    gap: 'GAP-F1', dirs: ['supabase/functions'],
    // plan-name literals used as a gate: `plan === "x"`, `plan.includes`, or an array of plan names
    pattern: /\bplan\b[^\n]{0,24}(?:===|==|!==|!=|\.includes\()[^\n]{0,24}['"](?:free|starter|professional|business|enterprise)['"]|\[\s*["'](?:business|enterprise|professional|starter)["']/i,
    allow: {
      'supabase/functions/_shared/fraud/planLimits.ts': 'the per-plan limits table itself',
      'supabase/functions/_shared/branding/brand.ts': 'white-label plan gate (real, matrix row feat:whiteLabel)',
      'supabase/functions/verify-custom-domain/index.ts': 'white-label plan gate (real, matrix row feat:whiteLabel)',
      'supabase/functions/_shared/siem/engine.ts': 'SIEM plan gate (real, matrix row feat:siem)',
      'supabase/functions/voice-consent/index.ts': 'voice-clone plan gate (real, matrix row voiceClone)',
    },
  },
  {
    gap: 'GAP-E1', dirs: ['supabase/functions'],
    pattern: /account_module_entitlements/,
    allow: {},
  },
  {
    gap: 'GAP-O1', dirs: ['supabase/functions'],
    pattern: /usageRecord|meterEvent|meter_event|createUsageRecord|overage_?rate|overageRate|parseOverageRate/i,
    allow: { 'supabase/functions/results-plan-bill/index.ts': 'meters RESULTS-PLAN usage only, not standard-plan overage' },
  },
];
