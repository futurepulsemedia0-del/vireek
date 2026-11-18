// src/lib/askVireek/route.ts
//
// Deliberate per-route rules for the unified "Ask Vireek" launcher. Replaces the
// old blanket hide on /dashboard* and /home*.

export type AssistantSurface = 'public' | 'dashboard' | 'auth' | 'hidden';

export type PageTopic =
  | 'pricing'
  | 'features'
  | 'integrations'
  | 'security'
  | 'getting-started'
  | 'help'
  | 'industries'
  | 'legal'
  | 'dashboard'
  | 'general';

export interface AssistantContext {
  surface: AssistantSurface;
  topic: PageTopic;
}

// Routes where a floating assistant would be wrong: staff tooling, kiosk/wallboard
// displays, embeds and documents meant to be printed or shown to a customer.
const HIDDEN_PREFIXES = ['/staff', '/wallboard', '/embed', '/print', '/kiosk', '/pay/', '/portal/'];
const AUTH_PREFIXES = ['/login', '/signup', '/forgot-password', '/reset-password', '/verify', '/mfa'];

const TOPIC_RULES: [PageTopic, RegExp][] = [
  ['pricing', /^\/(pricing|roi|calculator|compare)(\/|$)/],
  ['integrations', /^\/(integrations|marketplace|developers|api)(\/|$)/],
  ['security', /^\/(security|trust|responsible-ai|privacy|data-request|subprocessors)(\/|$)/],
  ['getting-started', /^\/(onboarding-guide|demo|beta|signup|get-started)(\/|$)/],
  ['help', /^\/(help|academy|docs|faq|contact|status)(\/|$)/],
  ['industries', /^\/(industries|industry|trades|use-cases)(\/|$)/],
  ['features', /^\/(features|platform|product|ai-receptionist)(\/|$)/],
  ['legal', /^\/(terms|msa|dmca|cookies?|cookie-policy|accessibility|accessibility-statement)(\/|$)/],
];

function startsWithAny(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`) || path === p.replace(/\/$/, ''));
}

export function getAssistantContext(pathname: string): AssistantContext {
  const path = (pathname || '/').toLowerCase();
  if (startsWithAny(path, HIDDEN_PREFIXES)) return { surface: 'hidden', topic: 'general' };
  if (path === '/dashboard' || path.startsWith('/dashboard/') || path === '/home' || path.startsWith('/home/')) {
    return { surface: 'dashboard', topic: 'dashboard' };
  }
  if (startsWithAny(path, AUTH_PREFIXES)) return { surface: 'auth', topic: 'help' };
  for (const [topic, re] of TOPIC_RULES) if (re.test(path)) return { surface: 'public', topic };
  return { surface: 'public', topic: 'general' };
}

/** i18n keys (askVireek namespace) of the suggested questions per topic. 4-6 each. */
export const SUGGESTION_KEYS: Record<PageTopic, string[]> = {
  pricing: ['pricing.cost', 'pricing.plan', 'pricing.overage', 'pricing.setup', 'pricing.cancel'],
  features: ['features.emergency', 'features.booking', 'features.transfer', 'industries.trades'],
  integrations: ['integrations.crm', 'integrations.api', 'integrations.calendar', 'integrations.plan'],
  security: ['security.data', 'security.certs', 'security.isolation', 'security.human'],
  'getting-started': ['start.free', 'start.number', 'start.time', 'start.demo'],
  help: ['help.reach', 'help.hours', 'start.free', 'pricing.cost'],
  industries: ['industries.trades', 'industries.plan', 'features.emergency', 'start.free'],
  legal: ['security.data', 'security.certs', 'help.reach'],
  dashboard: ['dash.phone', 'dash.calendar', 'dash.billing', 'dash.team', 'dash.export'],
  general: ['pricing.cost', 'industries.trades', 'features.emergency', 'security.data', 'start.free'],
};
