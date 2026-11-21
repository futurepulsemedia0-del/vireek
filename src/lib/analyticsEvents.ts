// src/lib/analyticsEvents.ts
//
// Single source of truth for every GA4 event Vireek sends. Human-readable plan: docs/analytics/tracking-plan.md.
// Rules (enforced by TypeScript, by the runtime guard in trackEvent(), and by `npm run lint:analytics`):
//   1. An event that is not listed here cannot be sent.
//   2. A property that is not listed for that event cannot be sent.
//   3. Every property is `pii: false`. The literal type makes `pii: true` a compile error: personal data does not go to GA.
//   4. No imports and only erasable TypeScript syntax, so plain Node (--experimental-strip-types) can load this file.

export type PropType = 'string' | 'number' | 'boolean';

export interface PropDef {
  readonly type: PropType;
  readonly optional: boolean;
  /** Must stay `false`. See rule 3. */
  readonly pii: false;
  readonly note: string;
}

export type EventOwner = 'growth' | 'product' | 'platform' | 'onboarding' | 'analytics';

export interface EventDef {
  readonly owner: EventOwner;
  readonly description: string;
  /** Event-level PII flag. Must stay `false`. */
  readonly pii: false;
  readonly properties: Readonly<Record<string, PropDef>>;
}

const str = <O extends boolean = false>(note: string, optional?: O) =>
  ({ type: 'string' as const, optional: (optional ?? false) as O, pii: false as const, note });
const num = <O extends boolean = false>(note: string, optional?: O) =>
  ({ type: 'number' as const, optional: (optional ?? false) as O, pii: false as const, note });
const bool = <O extends boolean = false>(note: string, optional?: O) =>
  ({ type: 'boolean' as const, optional: (optional ?? false) as O, pii: false as const, note });

const ev = <const P extends Readonly<Record<string, PropDef>>>(owner: EventOwner, description: string, properties: P) =>
  ({ owner, description, pii: false as const, properties });

const TOUR_STARTED_PROPS = {
  tour_id: str('Tour definition id'),
  version: num('Tour definition version'),
  step_count: num('Number of steps in the tour'),
  step_index: num('Zero-based step the tour (re)starts at'),
};
const TOUR_ENDED_PROPS = {
  tour_id: str('Tour definition id'),
  version: num('Tour definition version'),
  step_index: num('Zero-based step reached'),
  step_count: num('Number of steps in the tour'),
};

export const EVENT_REGISTRY = {
  // ---- Navigation -------------------------------------------------------------------------------------------
  page_view: ev('analytics', 'Route change. Sent by trackPageview(): wallboard and /audit paths are never sent, only utm_* query parameters are kept, no hash.', {
    page_path: str('Pathname plus utm_* query only; email/JWT segments redacted'),
    page_title: str('document.title, clamped to 100 chars'),
    page_location: str('Origin + page_path (no hash, no other query)'),
  }),

  // ---- Global search palette --------------------------------------------------------------------------------
  palette_open: ev('product', 'Command palette opened. Never carries query text.', {}),
  palette_select: ev('product', 'A palette result was chosen.', {
    scope: str('Palette scope'),
    kind: str('Result kind (id prefix) or "operator"'),
    position: num('Zero-based rank of the chosen result'),
    search_ms: num('Latency of the last search in ms; absent when none ran', true),
  }),

  plan_step_viewed
  plan_selected
  plan_checkout_started
  plan_checkout_completed
  plan_checkout_abandoned
  plan_step_skipped
  // ---- Product tours and tips -------------------------------------------------------------------------------
  tour_started: ev('onboarding', 'Tour auto-started.', TOUR_STARTED_PROPS),
  tour_resumed: ev('onboarding', 'Tour resumed after a pause.', TOUR_STARTED_PROPS),
  tour_replayed: ev('onboarding', 'Tour replayed by the user.', TOUR_STARTED_PROPS),
  tour_step_viewed: ev('onboarding', 'A tour step was shown.', {
    tour_id: str('Tour definition id'),
    step_id: str('Step id; absent when the index is out of range', true),
    step_index: num('Zero-based step index'),
  }),
  tour_completed: ev('onboarding', 'Tour finished.', TOUR_ENDED_PROPS),
  tour_skipped: ev('onboarding', 'Tour dismissed before the end.', TOUR_ENDED_PROPS),
  tour_paused: ev('onboarding', 'Tour paused.', {
    tour_id: str('Tour definition id'),
    step_index: num('Zero-based step index'),
  }),
  tip_dismissed: ev('onboarding', 'Contextual tip dismissed.', { tip_id: str('Tip id') }),
  tips_reset: ev('onboarding', 'User reset all tips.', {}),

  // ---- Activation -------------------------------------------------------------------------------------------
  first_call_answered: ev('onboarding', 'The first test call was answered (once per session).', {
    channel: str('"phone" or "browser"'),
    international: bool('Calling code is not +1'),
    ttfc_bucket: str('Bucketed time from signup to first answered call'),
  }),
  sarah_learn_readiness: ev('onboarding', 'Sarah-learn readiness scorecard ran.', {
    passed: num('Scenarios passed'),
    total: num('Scenarios run'),
    gate: bool('Go-live gate passed'),
  }),
  sarah_learn_go_live: ev('onboarding', 'Sarah-learn went live.', { ms: num('Elapsed ms') }),
  sarah_learn_first_draft: ev('onboarding', 'Sarah-learn produced a first draft.', {
    ms: num('Elapsed ms'),
    fields: num('Number of fields drafted'),
  }),
  sarah_learn_rerun: ev('onboarding', 'Sarah-learn rerun requested.', {}),

  // ---- Experiments ------------------------------------------------------------------------------------------
  experiment_exposure: ev('growth', 'User was exposed to an experiment variant (once per session).', {
    experiment_id: str('Experiment id'),
    variant_id: str('Variant id'),
  }),

  // ---- Business KPI dashboard -------------------------------------------------------------------------------
  dashboard_viewed: ev('analytics', 'Business KPI dashboard viewed.', {
    range_days: num('Selected range in days'),
    team_filtered: bool('A team filter is active'),
  }),
  csv_exported: ev('analytics', 'KPI CSV exported.', {
    granularity: str('Export granularity'),
    range_days: num('Selected range in days'),
  }),
  digest_toggled: ev('analytics', 'KPI digest setting changed.', {
    enabled: bool('Digest on/off'),
    cadence: str('Digest cadence'),
  }),
  anomaly_alert_opened: ev('analytics', 'KPI anomaly alert opened.', {
    metric: str('Metric id'),
    severity: str('Alert severity'),
  }),

  // ---- Blog -------------------------------------------------------------------------------------------------
  blog_scroll_depth: ev('growth', 'Scroll milestone reached.', {
    post_slug: str('Post slug'),
    percent: num('Milestone percent'),
  }),
  blog_cta_click: ev('growth', 'Blog CTA clicked.', {
    post_slug: str('Post slug'),
    cta_type: str('CTA type'),
    placement: str('"inline" or "end"'),
  }),
  blog_calculator_use: ev('growth', 'Blog calculator used.', { post_slug: str('Post slug') }),
  blog_newsletter_signup: ev('growth', 'Newsletter signup from the blog.', { source: str('Signup placement') }),
  blog_share: ev('growth', 'Blog post shared.', { post_slug: str('Post slug'), channel: str('Share channel') }),

  // ---- Conversions (GA4 recommended events + custom) --------------------------------------------------------
  sign_up: ev('growth', 'Trial signup completed (GA4 recommended event).', { method: str('Signup method') }),
  generate_lead: ev('growth', 'Lead generated (GA4 recommended event).', { lead_source: str('"signup" or "demo"') }),
  demo_booked: ev('growth', 'Demo booked.', { days_until_demo: num('Whole days until the demo; absent if unknown', true) }),
} as const satisfies Readonly<Record<string, EventDef>>;

export type EventRegistry = typeof EVENT_REGISTRY;
export type EventName = keyof EventRegistry;

type Props<N extends EventName> = EventRegistry[N]['properties'];
type PropValue<D> = D extends { readonly type: 'string' } ? string : D extends { readonly type: 'number' } ? number : boolean;
type ReqProps<N extends EventName> = {
  [K in keyof Props<N> as Props<N>[K] extends { readonly optional: true } ? never : K]: PropValue<Props<N>[K]>;
};
type OptProps<N extends EventName> = {
  [K in keyof Props<N> as Props<N>[K] extends { readonly optional: true } ? K : never]?: PropValue<Props<N>[K]>;
};

/** Exact parameter bag for an event. Events without properties accept none. */
export type EventParams<N extends EventName> = [keyof Props<N>] extends [never]
  ? Record<string, never>
  : ReqProps<N> & OptProps<N>;

/** Rest-args helper: params are mandatory when the event has a required property. */
export type EventArgs<N extends EventName> = [keyof ReqProps<N>] extends [never]
  ? [params?: EventParams<N>]
  : [params: EventParams<N>];

// ------------------------------------------------------------------------------------------------------------
// Shared validation (used at runtime by trackEvent, by the unit tests and by scripts/check-analytics-registry.mjs)
// ------------------------------------------------------------------------------------------------------------

/** GA4 limits: names <= 40 chars, string values <= 100 chars. */
export const GA_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const GA_MAX_VALUE_LENGTH = 100;
export const GA_RESERVED_PREFIXES = ['google_', 'gtag.', 'ga_', 'firebase_'] as const;

/** Property names that indicate personal data or free text. Registry entries matching this fail the lint. */
export const PII_PROPERTY_NAME_RE =
  /(^|_)(e?mail|phone|tel|mobile|name|first|last|address|street|city|zip|postal|ip|ssn|dob|birth|password|passwd|pwd|token|secret|jwt|auth|cookie|session|query|search_text|message|msg|comment|text|body|content|transcript|caller|lat|lng|latitude|longitude|geo|user_id|customer_id|account_id|contact_id|owner_id|tenant_id|device_id)(_|$)/i;

const EMAIL_VALUE_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const LONG_DIGITS_VALUE_RE = /\d[\d\s().-]{6,}\d/;
const JWT_VALUE_RE = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;

// ------------------------------------------------------------------------------------------------------------
// page_view URL hygiene
// ------------------------------------------------------------------------------------------------------------

/** The only query parameters that reach GA: standard campaign attribution. Everything else (and the #hash) is dropped. */
export const PAGE_VIEW_ALLOWED_QUERY = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
const REDACTED_SEGMENT = ':redacted';

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Builds the URL fields of a page_view from a pathname + search (+ optional hash).
 * - the #hash and every query parameter except PAGE_VIEW_ALLOWED_QUERY are removed;
 * - allowed values that look like personal data (or are too long) are removed;
 * - path segments that are an email address or a JWT are replaced with ":redacted".
 * `origin` is `window.location.origin`; pass '' to get a path-only location.
 */
export function sanitizePageUrl(pathWithSearch: string, origin: string): { page_path: string; page_location: string } {
  const url = new URL(pathWithSearch, 'https://placeholder.invalid');
  const pathname = url.pathname
    .split('/')
    .map((seg) => {
      const d = safeDecode(seg);
      return EMAIL_VALUE_RE.test(d) || JWT_VALUE_RE.test(d) ? REDACTED_SEGMENT : seg;
    })
    .join('/');
  const kept = new URLSearchParams();
  for (const key of PAGE_VIEW_ALLOWED_QUERY) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== '' && !looksLikePii(value)) kept.set(key, value);
  }
  const qs = kept.toString();
  const page_path = qs ? `${pathname}?${qs}` : pathname;
  return { page_path, page_location: `${origin}${page_path}` };
}

/** page_title is free text from the DOM: trim it to the GA4 value limit. */
export function clampPageTitle(title: string): string {
  return title.length > GA_MAX_VALUE_LENGTH ? title.slice(0, GA_MAX_VALUE_LENGTH - 1) + '…' : title;
}

export function isEventName(name: unknown): name is EventName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(EVENT_REGISTRY, name);
}

/** True when a runtime string value looks like personal data (email, phone-like number, JWT) or is too long for GA. */
export function looksLikePii(value: string): boolean {
  return value.length > GA_MAX_VALUE_LENGTH || EMAIL_VALUE_RE.test(value) || LONG_DIGITS_VALUE_RE.test(value) || JWT_VALUE_RE.test(value);
}

export interface SanitizedEvent {
  name: EventName;
  params: Record<string, string | number | boolean>;
}

export interface EventProblem {
  event: string;
  detail: string;
}

/**
 * Returns the event with only registered, correctly typed, PII-free parameters, or null when the event itself is not
 * registered. Every dropped item is appended to `problems`. Missing required parameters are reported but do not block the
 * event (analytics must never break a user flow).
 */
export function sanitizeEvent(name: string, params: Record<string, unknown> | undefined, problems: EventProblem[] = []): SanitizedEvent | null {
  if (!isEventName(name)) {
    problems.push({ event: name, detail: 'event is not in the registry' });
    return null;
  }
  const def: EventDef = EVENT_REGISTRY[name];
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    const prop = Object.prototype.hasOwnProperty.call(def.properties, key) ? def.properties[key] : undefined;
    if (!prop) {
      problems.push({ event: name, detail: `property "${key}" is not registered` });
    } else if (typeof value !== prop.type || (typeof value === 'number' && !Number.isFinite(value))) {
      problems.push({ event: name, detail: `property "${key}" must be a finite ${prop.type}` });
    } else if (typeof value === 'string' && looksLikePii(value)) {
      problems.push({ event: name, detail: `property "${key}" looks like personal data or is too long` });
    } else {
      out[key] = value as string | number | boolean;
    }
  }
  for (const [key, prop] of Object.entries(def.properties)) {
    if (!prop.optional && !(key in out)) problems.push({ event: name, detail: `required property "${key}" is missing` });
  }
  return { name, params: out };
}

/** Structural problems in the registry itself. Empty array = valid. */
export function validateRegistry(registry: Readonly<Record<string, EventDef>> = EVENT_REGISTRY): string[] {
  const errors: string[] = [];
  const bad = (m: string) => errors.push(m);
  for (const [name, def] of Object.entries(registry)) {
    if (!GA_NAME_RE.test(name)) bad(`${name}: event name must match ${GA_NAME_RE}`);
    if (GA_RESERVED_PREFIXES.some((p) => name.startsWith(p))) bad(`${name}: reserved GA prefix`);
    if (!def.owner) bad(`${name}: owner is required`);
    if (!def.description.trim()) bad(`${name}: description is required`);
    if ((def.pii as boolean) !== false) bad(`${name}: event-level pii must be false`);
    for (const [prop, p] of Object.entries(def.properties)) {
      if (!GA_NAME_RE.test(prop)) bad(`${name}.${prop}: property name must match ${GA_NAME_RE}`);
      if (GA_RESERVED_PREFIXES.some((x) => prop.startsWith(x))) bad(`${name}.${prop}: reserved GA prefix`);
      if ((p.pii as boolean) !== false) bad(`${name}.${prop}: pii must be false`);
      if (PII_PROPERTY_NAME_RE.test(prop)) bad(`${name}.${prop}: property name looks like PII or free text`);
      if (!p.note.trim()) bad(`${name}.${prop}: note is required`);
    }
    if (Object.keys(def.properties).length > 25) bad(`${name}: GA4 allows at most 25 parameters per event`);
  }
  return errors;
}
