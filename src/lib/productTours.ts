/**
 * Product tours — pure logic (no React, no network). Fully unit-tested in
 * productTours.test.ts. Tour copy below is the English default; every string is
 * looked up via i18n first (keys: tour.<role>.<stepId>.title|body, tour.tip.<id>.*)
 * so translations can be added to locales/*/dashboard.json without code changes.
 */

import type { UserPermissions } from '@/contexts/AuthContext';

export type TourRole = 'owner' | 'admin' | 'office' | 'technician';
export type TourStatus = 'in_progress' | 'completed' | 'skipped';
export type TourStatusLabel = 'not_started' | TourStatus;

export interface TourStep {
  id: string;
  title: string;
  /** May contain {{mod}} → ⌘ or Ctrl. */
  body: string;
  /** Page the step lives on; the overlay navigates there first. */
  route?: string;
  /** Selectors tried in order; the first VISIBLE match is spotlighted. None → centered card. */
  targets?: readonly string[];
  /** Step only appears for viewers with this permission (owners always pass). */
  permission?: keyof UserPermissions;
  /** Skipped automatically when its target never appears (e.g. hidden feature). */
  optional?: boolean;
}

export interface TourDef {
  id: TourRole;
  version: number;
  title: string;
  description: string;
  /** Pathnames where the tour may auto-start for first-time users. */
  entryPaths: readonly string[];
  /** Owners wait for onboarding; invited staff don't go through it. */
  requiresOnboarding: boolean;
  finishCta?: { label: string; href: string };
  steps: readonly TourStep[];
}

// ---------------------------------------------------------------------------
// Tour definitions
// ---------------------------------------------------------------------------

const SIDEBAR = '[data-tour="sidebar"]';
const MENU_BUTTON = '[data-tour="menu-button"]';
const TOUR_MENU = '[data-tour="tour-menu"]';
/** Nav link on desktop, hamburger on phones (where the sidebar is hidden). */
const navTarget = (href: string): readonly string[] => [`a[href="${href}"]`, MENU_BUTTON];

const SEARCH_STEP: TourStep = {
  id: 'search',
  title: 'Jump anywhere instantly',
  body: 'Press {{mod}} + K from any page to search and open anything. Press ? to see every keyboard shortcut.',
};
const ASSISTANT_STEP: TourStep = {
  id: 'assistant',
  title: 'Ask the AI assistant',
  body: 'Questions about your business, a customer or how something works? The assistant is always one tap away.',
  targets: ['button[aria-label="Open AI Assistant"]', 'button[aria-label="Close AI Assistant"]'],
  optional: true,
};
const REPLAY_STEP: TourStep = {
  id: 'replay',
  title: 'Replay this tour any time',
  body: 'Open the Help menu to replay the tour, resume where you left off, or bring back the tips you dismissed.',
  targets: [TOUR_MENU],
};
const NAV_STEP: TourStep = {
  id: 'navigation',
  title: 'Everything is one click away',
  body: 'Jobs, calls, customers, quotes and every tool live in the navigation. Items you don’t have access to are hidden automatically.',
  targets: [SIDEBAR, MENU_BUTTON],
};

const TECH_ROUTE = '/tech/today';

export const TOURS: Record<TourRole, TourDef> = {
  owner: {
    id: 'owner',
    version: 1,
    title: 'Owner tour',
    description: 'The places you’ll use every day to run the business.',
    entryPaths: ['/dashboard'],
    requiresOnboarding: true,
    finishCta: { label: 'Open setup checklist', href: '/dashboard/getting-started' },
    steps: [
      {
        id: 'welcome',
        route: '/dashboard',
        title: 'Welcome to Vireek',
        body: 'A short tour of where things live. Leave any time — we save your spot and you can replay it from the Help menu.',
      },
      NAV_STEP,
      {
        id: 'getting-started',
        title: 'Your setup checklist',
        body: 'Progress is tracked from your real data — no manual ticking. Pick up where you left off any time.',
        targets: navTarget('/dashboard/getting-started'),
        optional: true,
      },
      {
        id: 'calls',
        title: 'Every call, handled and summarized',
        body: 'Review the summary, transcript and outcome of every call your AI assistant answers.',
        targets: navTarget('/dashboard/calls'),
      },
      {
        id: 'jobs',
        title: 'Jobs from first call to paid',
        body: 'Schedule work, assign technicians and follow each job through to the invoice.',
        targets: navTarget('/dashboard/jobs'),
      },
      {
        id: 'customers',
        title: 'Your customers, in one place',
        body: 'Every call, job, quote and invoice links back to the right customer history.',
        targets: navTarget('/dashboard/customers'),
      },
      {
        id: 'quotes',
        title: 'Quote fast, win more work',
        body: 'Build a quote from your price book, send it, and convert it to a job when it’s approved.',
        targets: navTarget('/dashboard/quotes'),
      },
      {
        id: 'analytics',
        title: 'See what drives revenue',
        body: 'Track call volume, booked jobs and revenue so you know what’s working.',
        targets: navTarget('/dashboard/analytics'),
        permission: 'can_view_billing',
        optional: true,
      },
      SEARCH_STEP,
      ASSISTANT_STEP,
      REPLAY_STEP,
    ],
  },
  admin: {
    id: 'admin',
    version: 1,
    title: 'Admin tour',
    description: 'How to manage calls, jobs and customers as an admin.',
    entryPaths: ['/dashboard'],
    requiresOnboarding: false,
    steps: [
      {
        id: 'welcome',
        route: '/dashboard',
        title: 'Welcome to the team',
        body: 'You have admin access. This quick tour shows the tools you’ll use most. Leave any time and replay it from the Help menu.',
      },
      NAV_STEP,
      {
        id: 'calls',
        title: 'Every call, handled and summarized',
        body: 'Review the summary, transcript and outcome of every call the AI assistant answers.',
        targets: navTarget('/dashboard/calls'),
      },
      {
        id: 'jobs',
        title: 'Jobs from first call to paid',
        body: 'Schedule work, assign technicians and follow each job through completion.',
        targets: navTarget('/dashboard/jobs'),
      },
      {
        id: 'customers',
        title: 'Your customers, in one place',
        body: 'Every call, job, quote and invoice links to the right customer history.',
        targets: navTarget('/dashboard/customers'),
      },
      {
        id: 'quotes',
        title: 'Quote fast, win more work',
        body: 'Build, send and convert quotes without leaving the page.',
        targets: navTarget('/dashboard/quotes'),
      },
      {
        id: 'analytics',
        title: 'See what drives revenue',
        body: 'Track call volume, booked jobs and revenue.',
        targets: navTarget('/dashboard/analytics'),
        permission: 'can_view_billing',
        optional: true,
      },
      SEARCH_STEP,
      ASSISTANT_STEP,
      REPLAY_STEP,
    ],
  },
  office: {
    id: 'office',
    version: 1,
    title: 'Office & dispatch tour',
    description: 'Your day-to-day tools for calls, scheduling and customers.',
    entryPaths: ['/dashboard'],
    requiresOnboarding: false,
    steps: [
      {
        id: 'welcome',
        route: '/dashboard',
        title: 'Welcome to Vireek',
        body: 'Here’s a quick look at the tools you’ll use each day. Leave any time and replay it from the Help menu.',
      },
      NAV_STEP,
      {
        id: 'jobs',
        title: 'Your jobs',
        body: 'See what’s scheduled, update statuses and keep customers informed.',
        targets: navTarget('/dashboard/jobs'),
      },
      {
        id: 'calls',
        title: 'Call history',
        body: 'Open any call for the summary, transcript and what the AI booked or flagged.',
        targets: navTarget('/dashboard/calls'),
      },
      {
        id: 'customers',
        title: 'Customers',
        body: 'Find a customer and see every call, job and invoice at a glance.',
        targets: navTarget('/dashboard/customers'),
      },
      {
        id: 'quotes',
        title: 'Quotes',
        body: 'Create and send quotes, then turn approved ones into jobs.',
        targets: navTarget('/dashboard/quotes'),
      },
      {
        id: 'tasks',
        title: 'Tasks',
        body: 'Follow-ups and reminders assigned to you live here.',
        targets: navTarget('/dashboard/tasks'),
        optional: true,
      },
      {
        id: 'team-chat',
        title: 'Team chat',
        body: 'Message dispatch and technicians without leaving Vireek.',
        targets: navTarget('/dashboard/team-chat'),
        optional: true,
      },
      SEARCH_STEP,
      ASSISTANT_STEP,
      REPLAY_STEP,
    ],
  },
  technician: {
    id: 'technician',
    version: 1,
    title: 'Technician tour',
    description: 'How to work your jobs from the field.',
    entryPaths: [TECH_ROUTE],
    requiresOnboarding: false,
    steps: [
      {
        id: 'welcome',
        route: TECH_ROUTE,
        title: 'Welcome to your day',
        body: 'Everything you need in the field, in one place. Leave any time and replay it from the Help menu.',
      },
      {
        id: 'jobs',
        route: TECH_ROUTE,
        title: 'Today’s jobs',
        body: 'Your scheduled jobs appear here in order. Tap one to see the customer, address and notes.',
        targets: ['[data-tour="tech-jobs"]'],
        optional: true,
      },
      {
        id: 'status',
        route: TECH_ROUTE,
        title: 'Keep the office in the loop',
        body: 'Update each job as you go — en route, in progress, completed — so dispatch and the customer always know where things stand.',
      },
      {
        id: 'timesheet',
        route: TECH_ROUTE,
        title: 'Track your hours',
        body: 'Clock in and out from your timesheet so your hours are always accurate.',
        targets: ['a[href="/tech/timesheet"]'],
      },
      { ...REPLAY_STEP, route: TECH_ROUTE },
    ],
  },
};

// ---------------------------------------------------------------------------
// Contextual tips (first-time, per role, dismiss-once)
// ---------------------------------------------------------------------------

export type TipId =
  | 'jobs.create'
  | 'quotes.create'
  | 'customers.add'
  | 'calls.review'
  | 'tech.timesheet'
  | 'tech.job-card';

export interface TipDef {
  title: string;
  body: string;
  /** Only these roles see the tip. Omit for everyone. */
  roles?: readonly TourRole[];
  /** Role-specific copy overriding `body`. */
  roleBody?: Partial<Record<TourRole, string>>;
}

const DASHBOARD_ROLES: readonly TourRole[] = ['owner', 'admin', 'office'];

export const TIPS: Record<TipId, TipDef> = {
  'jobs.create': {
    title: 'Create your first job',
    body: 'Start here to schedule work for a customer. Quotes, photos and the invoice all hang off the job.',
    roles: DASHBOARD_ROLES,
  },
  'quotes.create': {
    title: 'Send a quote in minutes',
    body: 'Build a quote from your price book, send it by text or email, and convert it to a job once approved.',
    roles: DASHBOARD_ROLES,
  },
  'customers.add': {
    title: 'Add a customer',
    body: 'Add a customer so every call, job and invoice links to the right history.',
    roles: DASHBOARD_ROLES,
    roleBody: { owner: 'Add or import customers so calls and jobs connect to the right history from day one.' },
  },
  'calls.review': {
    title: 'Review how calls went',
    body: 'Open any call for the summary, transcript and outcome.',
    roles: DASHBOARD_ROLES,
  },
  'tech.timesheet': {
    title: 'Track your hours',
    body: 'Clock in and out here so your hours are always accurate.',
    roles: ['technician'],
  },
  'tech.job-card': {
    title: 'Tap a job to open it',
    body: 'See the customer, address and notes, then update your status as you go.',
    roles: ['technician'],
  },
};

export function tipCopy(id: TipId, role: TourRole): { title: string; body: string } {
  const tip = TIPS[id];
  return { title: tip.title, body: tip.roleBody?.[role] ?? tip.body };
}

// ---------------------------------------------------------------------------
// Roles & steps
// ---------------------------------------------------------------------------

export function resolveTourRole(input: {
  isOwner: boolean;
  profileRole?: string | null;
  teamRole?: string | null;
}): TourRole {
  if (input.isOwner) return 'owner';
  if (input.teamRole === 'technician') return 'technician';
  if (input.teamRole === 'admin' || input.profileRole === 'admin') return 'admin';
  return 'office';
}

export function visibleSteps(
  tour: Pick<TourDef, 'steps'>,
  viewer: { isOwner: boolean; permissions: Partial<UserPermissions> },
): TourStep[] {
  return tour.steps.filter(
    (s) => !s.permission || viewer.isOwner || viewer.permissions[s.permission] === true,
  );
}

export function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

// ---------------------------------------------------------------------------
// Progress records
// ---------------------------------------------------------------------------

export const TIP_PREFIX = 'tip:';
export const tipRecordId = (tipId: string) => `${TIP_PREFIX}${tipId}`;

export interface TourRecord {
  tourId: string;
  version: number;
  status: TourStatus;
  stepIndex: number;
  startedAt: string | null;
  completedAt: string | null;
  skippedAt: string | null;
  replayCount: number;
  updatedAt: string;
}
export type RecordMap = Record<string, TourRecord>;

export function clampStep(index: number, total: number): number {
  if (!Number.isFinite(index) || total <= 0) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), total - 1);
}

function emptyRecord(tourId: string, version: number, now: string): TourRecord {
  return {
    tourId, version, status: 'in_progress', stepIndex: 0,
    startedAt: null, completedAt: null, skippedAt: null, replayCount: 0, updatedAt: now,
  };
}

/** auto = first run · resume = continue a paused tour · replay = start over (counted). */
export function beginRecord(
  prev: TourRecord | undefined,
  def: { id: string; version: number },
  total: number,
  now: string,
  mode: 'auto' | 'resume' | 'replay',
): TourRecord {
  if (mode === 'resume' && prev && prev.status === 'in_progress') {
    return { ...prev, version: def.version, stepIndex: clampStep(prev.stepIndex, total), updatedAt: now };
  }
  const base = prev ?? emptyRecord(def.id, def.version, now);
  return {
    ...base,
    version: def.version,
    status: 'in_progress',
    stepIndex: 0,
    startedAt: now,
    replayCount: mode === 'replay' ? base.replayCount + 1 : base.replayCount,
    updatedAt: now,
  };
}

export function moveRecord(rec: TourRecord, index: number, total: number, now: string): TourRecord {
  return { ...rec, stepIndex: clampStep(index, total), updatedAt: now };
}

export function finishRecord(rec: TourRecord, status: 'completed' | 'skipped', now: string): TourRecord {
  return {
    ...rec,
    status,
    completedAt: status === 'completed' ? now : rec.completedAt,
    skippedAt: status === 'skipped' ? now : rec.skippedAt,
    updatedAt: now,
  };
}

export function tipRecord(tipId: string, now: string): TourRecord {
  return {
    tourId: tipRecordId(tipId), version: 1, status: 'completed', stepIndex: 0,
    startedAt: now, completedAt: now, skippedAt: null, replayCount: 0, updatedAt: now,
  };
}

export function describeStatus(rec?: TourRecord): TourStatusLabel {
  return rec ? rec.status : 'not_started';
}

/** People who finished the old single tour are not shown the new one again. */
export function reconcileLegacy(
  records: RecordMap,
  tour: Pick<TourDef, 'id' | 'version'> | null,
  legacyCompleted: boolean,
  now: string,
): TourRecord | null {
  if (!tour || !legacyCompleted || tour.id === 'technician' || records[tour.id]) return null;
  return {
    ...emptyRecord(tour.id, 0, now),
    status: 'completed',
    completedAt: now,
  };
}

const ts = (iso: string) => {
  const n = Date.parse(iso);
  return Number.isNaN(n) ? 0 : n;
};

/** Newest `updatedAt` wins per tour; `localNewer` are rows worth pushing to the server. */
export function mergeRecords(remote: RecordMap, local: RecordMap): { merged: RecordMap; localNewer: TourRecord[] } {
  const merged: RecordMap = { ...remote };
  const localNewer: TourRecord[] = [];
  for (const [id, l] of Object.entries(local)) {
    const r = remote[id];
    if (!r || ts(l.updatedAt) > ts(r.updatedAt)) {
      merged[id] = l;
      localNewer.push(l);
    }
  }
  return { merged, localNewer };
}

// ---------------------------------------------------------------------------
// Auto-start decision
// ---------------------------------------------------------------------------

export interface AutoStartInput {
  loaded: boolean;
  signedIn: boolean;
  profileReady: boolean;
  onboardingCompleted: boolean;
  tour: Pick<TourDef, 'entryPaths' | 'requiresOnboarding'> | null;
  record?: TourRecord;
  pathname: string;
  isActive: boolean;
  snoozed: boolean;
}
export type AutoStartAction = 'start' | 'resume-prompt' | null;

export function decideAutoStart(i: AutoStartInput): AutoStartAction {
  if (!i.loaded || !i.signedIn || !i.profileReady || !i.tour || i.isActive || i.snoozed) return null;
  if (i.tour.requiresOnboarding && !i.onboardingCompleted) return null;
  if (!i.tour.entryPaths.includes(normalizePath(i.pathname))) return null;
  if (!i.record) return 'start';
  return i.record.status === 'in_progress' ? 'resume-prompt' : null;
}

// ---------------------------------------------------------------------------
// Card placement
// ---------------------------------------------------------------------------

export interface Box { top: number; left: number; width: number; height: number }
export type CardPosition =
  | { kind: 'sheet' }
  | { kind: 'center' }
  | { kind: 'anchored'; top: number; left: number };

/** Below → above → right → left of the spotlight; bottom sheet on phones; centered if nothing fits. */
export function computeCardPosition(
  spot: Box | null,
  viewport: { w: number; h: number },
  card: { w: number; h: number },
  narrowBelow = 640,
): CardPosition {
  if (viewport.w < narrowBelow) return { kind: 'sheet' };
  if (!spot) return { kind: 'center' };
  const M = 16;
  const G = 16;
  const clampX = (x: number) => Math.min(Math.max(M, x), Math.max(M, viewport.w - card.w - M));
  const clampY = (y: number) => Math.min(Math.max(M, y), Math.max(M, viewport.h - card.h - M));

  const below = spot.top + spot.height + G;
  if (below + card.h <= viewport.h - M) return { kind: 'anchored', top: below, left: clampX(spot.left) };
  const above = spot.top - G - card.h;
  if (above >= M) return { kind: 'anchored', top: above, left: clampX(spot.left) };
  const right = spot.left + spot.width + G;
  if (right + card.w <= viewport.w - M) return { kind: 'anchored', top: clampY(spot.top), left: right };
  const left = spot.left - G - card.w;
  if (left >= M) return { kind: 'anchored', top: clampY(spot.top), left };
  return { kind: 'center' };
}
