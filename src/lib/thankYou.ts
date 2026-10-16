// Pure helpers for the public /thank-you page: URL parsing + conversion-event logic.
// No React / analytics imports so everything here is trivially testable.

export type ConversionSource = 'signup' | 'demo';

export interface ThankYouParams {
  source: ConversionSource | null;
  demoStart: Date | null;
}

const SOURCES: readonly ConversionSource[] = ['signup', 'demo'];
const DAY_MS = 86_400_000;

/**
 * /thank-you?source=signup | /thank-you?source=demo&start=<ISO date>
 * Unknown or missing source -> null (the page still renders, but never reports a conversion).
 * `start` is only honoured for demos and only when it is a real date between yesterday and a year out.
 */
export function parseThankYouParams(search: string, now: Date = new Date()): ThankYouParams {
  const params = new URLSearchParams(search);
  const raw = params.get('source');
  const source = SOURCES.find((s) => s === raw) ?? null;

  let demoStart: Date | null = null;
  const start = params.get('start');
  if (source === 'demo' && start) {
    const d = new Date(start);
    const ms = d.getTime();
    if (!Number.isNaN(ms) && ms > now.getTime() - DAY_MS && ms < now.getTime() + 366 * DAY_MS) demoStart = d;
  }
  return { source, demoStart };
}

export interface ConversionEvent {
  name: string;
  params: Record<string, unknown>;
}

/** GA4 recommended events (sign_up, generate_lead) plus a custom demo_booked. */
export function buildConversionEvents(source: ConversionSource, demoStart: Date | null, now: Date = new Date()): ConversionEvent[] {
  const lead: ConversionEvent = { name: 'generate_lead', params: { lead_source: source } };
  if (source === 'signup') return [{ name: 'sign_up', params: { method: 'trial_form' } }, lead];
  const days = demoStart ? Math.max(0, Math.round((demoStart.getTime() - now.getTime()) / DAY_MS)) : null;
  return [{ name: 'demo_booked', params: days === null ? {} : { days_until_demo: days } }, lead];
}

export interface ConversionDeps {
  track: (name: string, params?: Record<string, unknown>) => void;
  hasConsent: () => boolean;
  /** Subscribe to "analytics consent granted"; returns an unsubscribe function. */
  onConsent: (cb: () => void) => () => void;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
}

const storageKey = (source: ConversionSource) => `vireek:conversion:${source}`;

/**
 * Sends the source's conversion events at most once per browser session.
 * If analytics consent is not granted yet, waits for it (the cookie banner may be answered on this very page).
 * Returns a cleanup function.
 */
export function sendConversionOnce(source: ConversionSource, demoStart: Date | null, deps: ConversionDeps): () => void {
  const key = storageKey(source);
  const alreadySent = () => {
    try {
      return deps.storage?.getItem(key) === '1';
    } catch {
      return false;
    }
  };
  if (alreadySent()) return () => {};

  const send = () => {
    if (alreadySent()) return;
    for (const e of buildConversionEvents(source, demoStart)) deps.track(e.name, e.params);
    try {
      deps.storage?.setItem(key, '1');
    } catch {
      /* storage blocked: worst case a refresh reports again */
    }
  };

  if (deps.hasConsent()) {
    send();
    return () => {};
  }
  return deps.onConsent(send);
}

export function safeSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
