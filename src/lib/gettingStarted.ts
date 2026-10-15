/**
 * Getting Started — pure checklist logic (no React, no network).
 *
 * Step completion is DETECTED from real account data by
 * gettingStartedApi.ts; this module turns those raw signals plus the viewer's
 * permissions and skipped steps into the list the UI renders. Kept pure so
 * every rule below is unit-tested (gettingStarted.test.ts).
 */

import type { UserPermissions } from '@/contexts/AuthContext';

export type StepKey =
  | 'business_profile'
  | 'phone_number'
  | 'team'
  | 'integrations'
  | 'customer'
  | 'job'
  | 'price_book'
  | 'quote'
  | 'invoice'
  | 'first_call';

export type GroupKey = 'foundation' | 'operations' | 'revenue' | 'automation';

export interface StepDef {
  key: StepKey;
  group: GroupKey;
  title: string;
  description: string;
  href: string;
  cta: string;
  /** Needs this permission (owners always pass). */
  permission?: keyof UserPermissions;
  /**
   * Only the account owner sees it. Used where row-level security keys the
   * data to the signed-in user, so a team member's check would read as a
   * false "not done" even though the owner finished it.
   */
  ownerOnly?: boolean;
  /** Optional steps can be skipped; required ones cannot. */
  skippable: boolean;
}

export const GROUPS: { key: GroupKey; title: string; blurb: string }[] = [
  { key: 'foundation', title: 'Set up your business', blurb: 'So your AI assistant sounds like you and can answer calls.' },
  { key: 'operations', title: 'Run your operations', blurb: 'Bring your people, customers and work into Vireek.' },
  { key: 'revenue', title: 'Get paid', blurb: 'Price accurately, quote fast, invoice cleanly.' },
  { key: 'automation', title: 'Connect and automate', blurb: 'Plug in your tools and watch the first call come in.' },
];

export const STEPS: StepDef[] = [
  {
    key: 'business_profile', group: 'foundation', skippable: false,
    title: 'Complete your business profile',
    description: 'Add your hours, service area and the services you offer so the assistant answers accurately.',
    href: '/dashboard/business-profile', cta: 'Open profile', permission: 'can_edit_business_profile',
  },
  {
    key: 'phone_number', group: 'foundation', skippable: true, ownerOnly: true,
    title: 'Get a business phone number',
    description: 'Buy a new number or port your existing one so calls reach your assistant.',
    href: '/dashboard/phone-numbers', cta: 'Set up a number',
  },
  {
    key: 'team', group: 'operations', skippable: true,
    title: 'Invite a teammate or technician',
    description: 'Add dispatchers and technicians so jobs can be assigned and tracked.',
    href: '/dashboard/team', cta: 'Invite your team', permission: 'can_manage_team',
  },
  {
    key: 'customer', group: 'operations', skippable: false,
    title: 'Add your first customer',
    description: 'Add one by hand or import your list. Calls and jobs link to customers automatically.',
    href: '/dashboard/customers', cta: 'Add a customer',
  },
  {
    key: 'job', group: 'operations', skippable: false,
    title: 'Schedule your first job',
    description: 'Put a real or practice job on the board to see dispatch and tracking work end to end.',
    href: '/dashboard/jobs', cta: 'Create a job',
  },
  {
    key: 'price_book', group: 'revenue', skippable: true, ownerOnly: true,
    title: 'Build your price book',
    description: 'Save your standard services and prices so quotes are fast and consistent.',
    href: '/dashboard/price-book', cta: 'Open price book',
  },
  {
    key: 'quote', group: 'revenue', skippable: true, ownerOnly: true,
    title: 'Send your first quote',
    description: 'Create a quote customers can accept online.',
    href: '/dashboard/quotes', cta: 'Create a quote',
  },
  {
    key: 'invoice', group: 'revenue', skippable: true,
    title: 'Create your first invoice',
    description: 'Turn finished work into an invoice and get paid faster.',
    href: '/dashboard/invoicing', cta: 'Create an invoice', permission: 'can_view_billing',
  },
  {
    key: 'integrations', group: 'automation', skippable: true,
    title: 'Connect an integration',
    description: 'Link your calendar, accounting or CRM so data flows both ways.',
    href: '/dashboard/integrations', cta: 'Browse integrations',
  },
  {
    key: 'first_call', group: 'automation', skippable: true,
    title: 'Receive your first call',
    description: 'Call your Vireek number — the conversation appears in Call History with a summary.',
    href: '/dashboard/calls', cta: 'Open call history',
  },
];

/** `true` = done, `false` = not done, `null` = could not be checked. */
export type Signals = Record<StepKey, boolean | null>;

export type StepStatus = 'done' | 'todo' | 'skipped' | 'unknown';

export interface StepView extends StepDef {
  status: StepStatus;
}

export interface Viewer {
  isOwner: boolean;
  permissions: Partial<UserPermissions>;
}

export interface Summary {
  total: number;
  done: number;
  skipped: number;
  unknown: number;
  /** Share of steps genuinely completed, 0-100. Skipped steps do not inflate it. */
  pct: number;
  /** Nothing left to do: every step is done or skipped (and none is unknown). */
  complete: boolean;
  next: StepView | null;
}

export interface ProfileFields {
  services_offered: string[] | null;
  service_area: string | null;
  business_hours: Record<string, unknown> | null;
}

/** Hours AND at least one of services / service area — the minimum the assistant needs. */
export function isProfileComplete(p: ProfileFields | null): boolean {
  if (!p) return false;
  const hasHours = !!p.business_hours && Object.keys(p.business_hours).length > 0;
  const hasServices = Array.isArray(p.services_offered) && p.services_offered.some((s) => s.trim().length > 0);
  const hasArea = typeof p.service_area === 'string' && p.service_area.trim().length > 0;
  return hasHours && (hasServices || hasArea);
}

export function isVisibleTo(step: StepDef, viewer: Viewer): boolean {
  if (step.ownerOnly && !viewer.isOwner) return false;
  if (!step.permission || viewer.isOwner) return true;
  return !!viewer.permissions[step.permission];
}

/** Detected completion always wins over a skip; unknown is never guessed. */
export function buildChecklist(signals: Signals, skipped: readonly string[], viewer: Viewer): StepView[] {
  const skipSet = new Set(skipped);
  return STEPS.filter((s) => isVisibleTo(s, viewer)).map((s) => {
    const detected = signals[s.key];
    let status: StepStatus;
    if (detected === true) status = 'done';
    else if (s.skippable && skipSet.has(s.key)) status = 'skipped';
    else if (detected === null || detected === undefined) status = 'unknown';
    else status = 'todo';
    return { ...s, status };
  });
}

export function summarize(steps: readonly StepView[]): Summary {
  const total = steps.length;
  const count = (st: StepStatus) => steps.filter((s) => s.status === st).length;
  const done = count('done');
  const skipped = count('skipped');
  const unknown = count('unknown');
  return {
    total,
    done,
    skipped,
    unknown,
    pct: total === 0 ? 0 : Math.round((done / total) * 100),
    complete: total > 0 && done + skipped === total,
    next: steps.find((s) => s.status === 'todo') ?? null,
  };
}

/** Ignore unknown / non-skippable keys that may come back from storage. */
export function sanitizeSkipped(raw: unknown): StepKey[] {
  if (!Array.isArray(raw)) return [];
  const ok = new Set(STEPS.filter((s) => s.skippable).map((s) => s.key));
  return [...new Set(raw.filter((k): k is StepKey => typeof k === 'string' && ok.has(k as StepKey)))];
}
