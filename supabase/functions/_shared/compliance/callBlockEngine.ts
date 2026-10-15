// supabase/functions/_shared/compliance/callBlockEngine.ts
//
// Inbound call blocking + number-list parsing: pure, deterministic, NO imports
// and NO I/O. Single source of truth for three consumers:
//   - the live call path (callBlockCheck.ts -> vapi-webhook assistant-request)
//   - the dashboard "Test a number" panel (src/lib/callBlocklist.ts re-exports it)
//   - unit tests
// so what the dashboard simulates is exactly what callers experience.
//
// Decision order (first hit wins):
//   1. active per-call override  -> ALLOW  (owner explicitly let this number through)
//   2. manual blocklist entry    -> BLOCK
//   3. auto-block rules (enabled)-> BLOCK
//   4. otherwise                 -> ALLOW
// Overrides beat everything on purpose: a human decision is more specific than a rule.
//
// normalizePhone() mirrors _shared/compliance/dncCheck.ts byte-for-byte so a
// number maps to the SAME key in dnc_suppressions and call_blocklist.

export type BlockCategory = 'spam' | 'robocall' | 'scam' | 'manual';
export type DncReason = 'customer_opt_out' | 'manual' | 'national_registry';
export type BlockRuleKind = 'prefix' | 'anonymous' | 'neighbor_spoof' | 'repeat_short_calls';

export interface BlockRuleConfig {
  /** kind === 'prefix' — E.164 prefix, e.g. "+1900" or "+44". */
  prefix?: string;
  /** kind === 'repeat_short_calls' */
  minCalls?: number;
  maxSeconds?: number;
  windowHours?: number;
}

export interface BlockRule {
  id: string;
  name: string;
  kind: BlockRuleKind;
  enabled: boolean;
  config: BlockRuleConfig;
}

export interface BlockOverride {
  id: string;
  phone: string;
  expiresAt: string;
  usesRemaining: number;
}

export interface RecentCall {
  phone: string | null;
  durationSeconds: number | null;
  /** ISO timestamp the call started. */
  at: string;
}

export interface BlockInput {
  callerNumber: string | null;
  /** The business number that was dialed (needed for neighbor-spoof detection). */
  dialedNumber: string | null;
  now: Date;
  recentCalls: RecentCall[];
}

export interface BlockContext {
  /** normalized phone -> category */
  blocklist: ReadonlyMap<string, BlockCategory>;
  rules: BlockRule[];
  overrides: BlockOverride[];
}

export interface BlockDecision {
  blocked: boolean;
  reason: 'override' | 'blocklist' | 'rule' | 'none';
  ruleId?: string;
  overrideId?: string;
  category?: BlockCategory;
  detail: string;
}

export const MAX_IMPORT_ROWS = 10000;
export const MAX_NOTE_LENGTH = 200;
export const MAX_RULES = 25;
export const RULE_LIMITS = {
  minCalls: { min: 2, max: 20, default: 3 },
  maxSeconds: { min: 1, max: 120, default: 15 },
  windowHours: { min: 1, max: 168, default: 24 },
} as const;

const E164 = /^\+[1-9]\d{7,14}$/;
// Carrier "hidden caller ID" markers (Twilio documents these four) + plain words.
const ANONYMOUS_MARKERS = new Set(['+266696687', '+86282452253', '+464', '+7378742883']);
const ANONYMOUS_WORDS = new Set(['anonymous', 'restricted', 'unknown', 'private', 'blocked', 'unavailable', 'withheld']);

/** MUST stay identical to dncCheck.normalizePhone. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone.startsWith('+') ? phone : `+${digits}`;
}

/** Normalized + validated E.164, or null if it is not a dialable number. */
export function toE164(raw: string): string | null {
  const n = normalizePhone(raw.trim()).replace(/[^\d+]/g, '');
  return E164.test(n) ? n : null;
}

export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function isAnonymousCaller(raw: string | null | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return true;
  if (ANONYMOUS_WORDS.has(v)) return true;
  const compact = v.replace(/[^\d+]/g, '');
  if (!/\d/.test(v)) return true;
  return ANONYMOUS_MARKERS.has(compact);
}

export function normalizePrefix(raw: string): string {
  const cleaned = raw.replace(/[^\d+]/g, '');
  const digits = cleaned.replace(/\+/g, '');
  return digits ? `+${digits}` : '';
}

export function validateRule(rule: Pick<BlockRule, 'name' | 'kind' | 'config'>): string[] {
  const errors: string[] = [];
  if (!rule.name.trim()) errors.push('Give the rule a name.');
  if (rule.name.length > 80) errors.push('Rule name is limited to 80 characters.');
  if (rule.kind === 'prefix' && !/^\+\d{1,9}$/.test(rule.config.prefix ?? '')) {
    errors.push('Enter a prefix like +1900 or +44 (country/area code digits only).');
  }
  if (rule.kind === 'repeat_short_calls') {
    const { minCalls = RULE_LIMITS.minCalls.default, maxSeconds = RULE_LIMITS.maxSeconds.default, windowHours = RULE_LIMITS.windowHours.default } = rule.config;
    for (const [label, value, lim] of [
      ['Number of calls', minCalls, RULE_LIMITS.minCalls],
      ['Call length', maxSeconds, RULE_LIMITS.maxSeconds],
      ['Time window', windowHours, RULE_LIMITS.windowHours],
    ] as const) {
      if (!Number.isInteger(value) || value < lim.min || value > lim.max) errors.push(`${label} must be between ${lim.min} and ${lim.max}.`);
    }
  }
  return errors;
}

function evaluateRule(rule: BlockRule, key: string | null, input: BlockInput): string | null {
  switch (rule.kind) {
    case 'anonymous':
      return key === null ? 'Caller ID is hidden' : null;
    case 'prefix': {
      const prefix = rule.config.prefix;
      return key && prefix && key.startsWith(prefix) ? `Number starts with ${prefix}` : null;
    }
    case 'neighbor_spoof': {
      const dialed = input.dialedNumber ? normalizePhone(input.dialedNumber) : null;
      if (!key || !dialed || key === dialed) return null;
      const nanp = /^\+1\d{10}$/;
      if (!nanp.test(key) || !nanp.test(dialed)) return null;
      // Same area code + exchange (NPA-NXX) as the number they dialed, but not that number.
      return key.slice(2, 8) === dialed.slice(2, 8) ? 'Caller ID imitates your own area code and exchange' : null;
    }
    case 'repeat_short_calls': {
      if (!key) return null;
      const min = rule.config.minCalls ?? RULE_LIMITS.minCalls.default;
      const max = rule.config.maxSeconds ?? RULE_LIMITS.maxSeconds.default;
      const hours = rule.config.windowHours ?? RULE_LIMITS.windowHours.default;
      const since = input.now.getTime() - hours * 3_600_000;
      const hits = input.recentCalls.filter((c) => {
        const t = Date.parse(c.at);
        return c.phone && normalizePhone(c.phone) === key && c.durationSeconds !== null && c.durationSeconds < max && t >= since && t <= input.now.getTime();
      }).length;
      return hits >= min ? `${hits} calls shorter than ${max}s in the last ${hours}h` : null;
    }
  }
}

export function evaluateBlock(input: BlockInput, ctx: BlockContext): BlockDecision {
  const anonymous = isAnonymousCaller(input.callerNumber);
  const key = anonymous ? null : normalizePhone(input.callerNumber as string);

  if (key) {
    const override = ctx.overrides.find((o) => o.phone === key && o.usesRemaining > 0 && Date.parse(o.expiresAt) > input.now.getTime());
    if (override) return { blocked: false, reason: 'override', overrideId: override.id, detail: 'Allowed by a one-time override' };
    const category = ctx.blocklist.get(key);
    if (category) return { blocked: true, reason: 'blocklist', category, detail: `On your blocklist (${category})` };
  }

  for (const rule of ctx.rules) {
    if (!rule.enabled) continue;
    const why = evaluateRule(rule, key, input);
    if (why) return { blocked: true, reason: 'rule', ruleId: rule.id, detail: `${rule.name}: ${why}` };
  }
  return { blocked: false, reason: 'none', detail: anonymous ? 'Caller ID hidden, but no rule blocks anonymous callers' : 'No block applies' };
}

// ---------------------------------------------------------------------------
// Bulk-import parsing
// ---------------------------------------------------------------------------

export interface ParsedRow {
  line: number;
  phone: string;
  note: string | null;
}
export interface ParseResult {
  valid: ParsedRow[];
  invalid: { line: number; raw: string; reason: string }[];
  duplicates: number;
  truncated: boolean;
}

/** Accepts one number per line, optionally "number,note" (comma, semicolon or tab). A header row is skipped. */
export function parseNumberList(text: string, maxRows = MAX_IMPORT_ROWS): ParseResult {
  const result: ParseResult = { valid: [], invalid: [], duplicates: 0, truncated: false };
  const seen = new Set<string>();
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let firstContent = true;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const [first = '', ...rest] = raw.split(/[,;\t]/);
    const cell = first.trim().replace(/^["']|["']$/g, '');

    if (firstContent) {
      firstContent = false;
      if (/[a-z]/i.test(cell) && !/\d/.test(cell)) continue; // header row like "phone,note"
    }
    if (result.valid.length >= maxRows) {
      result.truncated = true;
      break;
    }
    if (/[a-z]/i.test(cell)) {
      result.invalid.push({ line: i + 1, raw: raw.slice(0, 60), reason: 'Not a phone number' });
      continue;
    }
    const phone = toE164(cell);
    if (!phone) {
      result.invalid.push({ line: i + 1, raw: raw.slice(0, 60), reason: 'Invalid number — use 10 digits or international format (+...)' });
      continue;
    }
    if (seen.has(phone)) {
      result.duplicates++;
      continue;
    }
    seen.add(phone);
    const note = rest.join(' ').trim().replace(/^["']|["']$/g, '').slice(0, MAX_NOTE_LENGTH);
    result.valid.push({ line: i + 1, phone, note: note || null });
  }
  return result;
}
