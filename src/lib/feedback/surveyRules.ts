// Client-side survey gate. The server (survey_claim) owns frequency caps, snooze, never-ask,
// per-subject answers and new-account rules. This file owns what only the browser knows:
// consent, critical flows, recent errors, open dialogs, typing, visibility.

export type SurveySuppression =
  | 'no_consent' | 'critical_route' | 'recent_error' | 'modal_open' | 'typing' | 'hidden' | 'offline';

/** Routes where an interruption is never acceptable (money, auth, emergencies, live field work). */
export const CRITICAL_ROUTE_PREFIXES: readonly string[] = [
  '/login', '/signup', '/forgot-password', '/onboarding', '/checkout', '/pay',
  '/dashboard/billing', '/dashboard/settings/security', '/dashboard/emergency', '/dashboard/dispatch', '/tech',
];

export interface SurveyGateInput {
  analyticsConsent: boolean;
  pathname: string;
  now: number;
  lastErrorAt: number;
  errorQuietMs: number;
  modalOpen: boolean;
  typing: boolean;
  visible: boolean;
  online: boolean;
}

export function isCriticalRoute(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return CRITICAL_ROUTE_PREFIXES.some((x) => p === x || p.startsWith(x + '/'));
}

export function evaluateSurveyGate(i: SurveyGateInput): { show: true } | { show: false; reason: SurveySuppression } {
  if (!i.analyticsConsent) return { show: false, reason: 'no_consent' };
  if (!i.visible) return { show: false, reason: 'hidden' };
  if (!i.online) return { show: false, reason: 'offline' };
  if (isCriticalRoute(i.pathname)) return { show: false, reason: 'critical_route' };
  if (i.lastErrorAt > 0 && i.now - i.lastErrorAt < i.errorQuietMs) return { show: false, reason: 'recent_error' };
  if (i.modalOpen) return { show: false, reason: 'modal_open' };
  if (i.typing) return { show: false, reason: 'typing' };
  return { show: true };
}

export function isTypingTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

export const SURVEY_SCALES = {
  csat: { min: 1, max: 5, lowMax: 2, question: 'How satisfied are you with this?', lo: 'Very unsatisfied', hi: 'Very satisfied' },
  ces: { min: 1, max: 7, lowMax: 3, question: 'How easy was it to get this done?', lo: 'Very difficult', hi: 'Very easy' },
} as const;

export const isLowScore = (type: 'csat' | 'ces', score: number): boolean => score <= SURVEY_SCALES[type].lowMax;
