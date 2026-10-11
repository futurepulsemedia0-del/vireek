import { ACADEMY_COURSES, type AcademyCourse } from './academy';
import type { UserPermissions } from '@/contexts/AuthContext';

// ============================================================
// TYPES
// ============================================================

export type HelpCategoryId = 'getting-started' | 'calls' | 'jobs' | 'customers' | 'inventory' | 'account';

export interface HelpCategory {
  id: HelpCategoryId;
  name: string;
  description: string;
}

export interface HelpArticle {
  id: string;
  category: HelpCategoryId;
  title: string;
  summary: string;
  /** Paragraphs, rendered as plain text (never as HTML). */
  body: string[];
  steps?: string[];
  /** Extra search terms people might type that the copy doesn't contain. */
  keywords: string[];
  /** Dashboard route prefixes this article is contextual for. */
  routes: string[];
  /** HelpVideo ids (Academy lesson ids). */
  videoIds?: string[];
  /** Hidden from people who lack this permission (owners always pass). */
  permission?: keyof UserPermissions;
}

export interface HelpVideo {
  /** Academy lesson id — the Academy stays the single source of truth for video content. */
  id: string;
  title: string;
  minutes: number;
  description: string;
  url: string;
  courseSlug: string;
  courseTitle: string;
  routes: string[];
}

export const HELP_SUPPORT_EMAIL = 'ali@vireek.com';

// ============================================================
// CONTENT
// ============================================================

export const HELP_CATEGORIES: HelpCategory[] = [
  { id: 'getting-started', name: 'Getting started', description: 'Set up your profile, forward your calls, and run a first test.' },
  { id: 'calls', name: 'Calls & messages', description: 'Understand what Sarah handled and what needs you.' },
  { id: 'jobs', name: 'Jobs & scheduling', description: 'Dispatch, calendar, and getting work done.' },
  { id: 'customers', name: 'Customers & sales', description: 'Leads, quotes, prices, reviews and memberships.' },
  { id: 'inventory', name: 'Parts & inventory', description: 'Stock, transfers, purchase orders and cycle counts.' },
  { id: 'account', name: 'Account & team', description: 'Team permissions, billing, integrations and shortcuts.' },
];

export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: 'make-a-test-call',
    category: 'getting-started',
    title: 'Make a test call before you go live',
    summary: 'Hear exactly what customers hear and see what lands in your dashboard.',
    body: [
      'A test call is the fastest way to check your greeting, your services and your hours. Call your forwarded number from a phone that is not your business line.',
      'Afterwards, open Call History: the call appears with its summary and any details Sarah captured, so you can confirm the whole path works end to end.',
    ],
    steps: ['Forward your calls (see "Forward your business number").', 'Call the number from another phone and book a pretend job.', 'Open Call History and review the call that just came in.', 'Adjust your Business Profile and test again until it sounds right.'],
    keywords: ['test', 'demo', 'first call', 'go live', 'launch'],
    routes: ['/dashboard', '/dashboard/calls'],
    videoIds: ['first-test-call'],
  },
  {
    id: 'business-profile',
    category: 'getting-started',
    title: 'Set up your Business Profile',
    summary: 'Services, service area, hours and the emergency policy Sarah follows on every call.',
    body: [
      'Sarah answers using what is in your Business Profile, so this is the page that most changes call quality. Keep your services, service area and hours current.',
      'Add the emergency policy and escalation contact so urgent calls reach the right person.',
    ],
    keywords: ['profile', 'hours', 'services', 'service area', 'script', 'greeting', 'emergency', 'escalation'],
    routes: ['/dashboard/business-profile'],
    videoIds: ['business-profile'],
    permission: 'can_edit_business_profile',
  },
  {
    id: 'forward-your-number',
    category: 'getting-started',
    title: 'Forward your business number',
    summary: 'Keep the number customers know and let Vireek answer it.',
    body: [
      'You do not need to change your business number. Most businesses forward calls to Vireek — all calls, after-hours only, or overflow when your line is busy — so Sarah answers under the number customers already dial.',
      'Forwarding is set up with your phone carrier. Once it is on, place a test call to confirm it reaches Sarah.',
    ],
    keywords: ['forwarding', 'phone', 'number', 'carrier', 'overflow', 'after hours', 'call forward'],
    routes: ['/dashboard/phone-numbers'],
    videoIds: ['call-forwarding'],
  },
  {
    id: 'read-call-history',
    category: 'calls',
    title: 'Read your Call History',
    summary: 'Find a call, see what was captured, and follow up.',
    body: [
      'Call History lists every call Sarah handled. Open a call to see what the caller wanted and the details captured, then follow up from the same place.',
      'Use the search and filters at the top to narrow down to a caller, a day or a type of call.',
    ],
    keywords: ['calls', 'history', 'transcript', 'voicemail', 'caller', 'recording', 'follow up'],
    routes: ['/dashboard/calls', '/dashboard/voicemails', '/dashboard/inbox'],
  },
  {
    id: 'dispatch-board',
    category: 'jobs',
    title: 'Read the Dispatch Board',
    summary: 'See how booked jobs move from new to scheduled to done, and where to step in.',
    body: [
      'Jobs Sarah books show up on the Dispatch Board. Each job moves from new, to scheduled, to done — anything stuck in an earlier stage is where you should look first.',
      'Assign a technician to a job to put it on their schedule.',
    ],
    keywords: ['dispatch', 'assign', 'technician', 'schedule', 'board', 'jobs'],
    routes: ['/dashboard/dispatch', '/dashboard/jobs'],
    videoIds: ['dispatch-board'],
  },
  {
    id: 'calendar-and-visibility',
    category: 'jobs',
    title: 'Why can I only see some jobs?',
    summary: 'Technicians see their own jobs unless they have permission to view all jobs.',
    body: [
      'Team members without the "view all jobs" permission only see jobs assigned to them. Owners, and members who have been given that permission, see every job.',
      'If a technician cannot find a job, check it is assigned to them, or ask an owner to change their permissions on the Team page.',
    ],
    keywords: ['calendar', 'missing job', 'cannot see', 'permission', 'assigned', 'visibility'],
    routes: ['/dashboard/calendar', '/dashboard/jobs'],
  },
  {
    id: 'price-book',
    category: 'customers',
    title: 'Set up your Live Price Book',
    summary: 'Give Sarah real prices to quote instead of promising a callback.',
    body: [
      'The Price Book holds the services and prices Sarah can quote on a call. The more complete it is, the fewer callbacks you need to make.',
      'Keep prices current — what is in the Price Book is what customers are quoted.',
    ],
    keywords: ['prices', 'pricing', 'quote', 'rates', 'services', 'estimate'],
    routes: ['/dashboard/price-book'],
    videoIds: ['price-book'],
  },
  {
    id: 'quotes',
    category: 'customers',
    title: 'Create a quote and turn it into an invoice',
    summary: 'Send a quote, get approval, then convert it to an invoice.',
    body: [
      'Build a quote from your Price Book, send it to the customer, and once it is accepted convert it into an invoice without retyping anything.',
    ],
    keywords: ['quote', 'estimate', 'invoice', 'proposal', 'approve'],
    routes: ['/dashboard/quotes'],
  },
  {
    id: 'leads-and-customers',
    category: 'customers',
    title: 'Leads and customers',
    summary: 'Where new callers go, and how they become customers.',
    body: [
      'New callers who have not booked yet appear under Leads so nothing slips through. Customers holds everyone you have worked with, with their history in one place.',
    ],
    keywords: ['lead', 'customer', 'contact', 'crm', 'follow up'],
    routes: ['/dashboard/leads', '/dashboard/customers'],
  },
  {
    id: 'reviews-and-memberships',
    category: 'customers',
    title: 'Reviews and memberships',
    summary: 'Turn finished jobs into 5-star reviews and recurring revenue.',
    body: ['Ask for a review when a job is finished, and offer a membership to customers who come back. Both are set up from your customer and job screens.'],
    keywords: ['reviews', 'google', 'stars', 'memberships', 'recurring', 'maintenance plan'],
    routes: ['/dashboard/customers'],
    videoIds: ['reviews-memberships'],
  },
  {
    id: 'inventory-overview',
    category: 'inventory',
    title: 'How Parts & Inventory works',
    summary: 'Locations, stock levels, transfers, purchase orders, serials and returns.',
    body: [
      'Stock lives at locations — a warehouse or a technician van. Every change (receiving, using on a job, transferring, adjusting) is written to an append-only ledger, and the on-hand numbers you see are calculated from it.',
      'Because the ledger is never edited, a mistake is corrected with an adjustment — and the cleanest way to find and fix mistakes is a cycle count.',
    ],
    keywords: ['stock', 'parts', 'warehouse', 'van', 'ledger', 'on hand', 'reorder', 'purchase order', 'transfer'],
    routes: ['/dashboard/inventory'],
  },
  {
    id: 'cycle-counts',
    category: 'inventory',
    title: 'Run a cycle count',
    summary: 'Count a van or warehouse, review variances, and post approved corrections.',
    body: [
      'A cycle count freezes the quantities the system expects at one location, lets you scan or type what is actually on the shelf, and shows the difference.',
      'Choose "Blind count" to hide the expected quantity from counters, so they count what they see rather than confirming the system. A part can only be in one open count per location at a time.',
    ],
    steps: [
      'Open Cycle Counts and choose Start a count.',
      'Pick the location and what to count: everything, one category, specific parts, or your highest-value parts.',
      'Scan a barcode, type a part number, or use the + and − buttons. Use "None on shelf" when a part is out.',
      'Add a note on any line that looks wrong, then submit the count for approval.',
    ],
    keywords: ['count', 'stocktake', 'stock take', 'inventory count', 'audit', 'shrink', 'variance', 'scan', 'barcode'],
    routes: ['/dashboard/inventory/counts'],
  },
  {
    id: 'approve-a-count',
    category: 'inventory',
    title: 'Review and approve a count',
    summary: 'Check the variance report, then post adjustments or send lines back for a recount.',
    body: [
      'The variance report lists differences with the biggest impact first. Tick lines you do not trust and return them for recount with a note, or approve to post every variance as an adjustment in the stock ledger.',
      'Approving cannot be undone. If something was approved by mistake, correct it with a new count.',
    ],
    keywords: ['approve', 'variance', 'adjustment', 'recount', 'manager', 'review'],
    routes: ['/dashboard/inventory/counts'],
    permission: 'can_manage_team',
  },
  {
    id: 'team-permissions',
    category: 'account',
    title: 'Team members and permissions',
    summary: 'Control who can see billing, manage the team, edit the profile and view all jobs.',
    body: [
      'Each team member can be given any of: view billing, manage team, edit business profile, and view all jobs. Owners have all of them.',
      'Give people only what their role needs — for example, technicians usually do not need billing access.',
    ],
    keywords: ['team', 'invite', 'roles', 'permissions', 'access', 'admin', 'technician'],
    routes: ['/dashboard/team'],
    permission: 'can_manage_team',
  },
  {
    id: 'billing',
    category: 'account',
    title: 'Billing and plan',
    summary: 'Review your plan, usage and payment details.',
    body: ['Billing shows your current plan and payment details. Only owners, and team members with billing access, can open it.'],
    keywords: ['billing', 'plan', 'invoice', 'payment', 'subscription', 'card', 'usage'],
    routes: ['/dashboard/billing'],
    permission: 'can_view_billing',
  },
  {
    id: 'integrations',
    category: 'account',
    title: 'Connect your other tools',
    summary: 'Link calendars, accounting and other tools you already use.',
    body: ['Open Integrations, pick a tool, and follow the prompts to connect it. You can disconnect it from the same screen at any time.'],
    keywords: ['integration', 'connect', 'calendar', 'accounting', 'quickbooks', 'api', 'sync'],
    routes: ['/dashboard/integrations'],
  },
  {
    id: 'keyboard-shortcuts',
    category: 'account',
    title: 'Keyboard shortcuts',
    summary: 'Move around the dashboard without the mouse.',
    body: [
      'Press ? anywhere in the dashboard to see every shortcut. For example, press g and then o to jump to Overview.',
      'The command palette lets you search for any page by name.',
    ],
    keywords: ['shortcuts', 'keyboard', 'hotkeys', 'command palette', 'search'],
    routes: ['/dashboard'],
  },
  {
    id: 'contact-support',
    category: 'account',
    title: 'Contact support',
    summary: 'Cannot find your answer? Reach a person.',
    body: [`Email ${HELP_SUPPORT_EMAIL} and include the page you were on and what you expected to happen. Screenshots help.`],
    keywords: ['support', 'contact', 'help', 'email', 'problem', 'bug', 'issue'],
    routes: [],
  },
];

/** Friendly page names for the "Help for this page" heading. Longest matching prefix wins. */
export const HELP_PAGE_LABELS: Record<string, string> = {
  '/dashboard': 'Overview',
  '/dashboard/calls': 'Call History',
  '/dashboard/voicemails': 'Voicemails',
  '/dashboard/inbox': 'Inbox',
  '/dashboard/leads': 'Leads',
  '/dashboard/customers': 'Customers',
  '/dashboard/jobs': 'My Jobs',
  '/dashboard/calendar': 'Calendar',
  '/dashboard/dispatch': 'Dispatch Board',
  '/dashboard/price-book': 'Price Book',
  '/dashboard/quotes': 'Quotes',
  '/dashboard/inventory': 'Parts & Inventory',
  '/dashboard/inventory/counts': 'Cycle Counts',
  '/dashboard/phone-numbers': 'Phone Numbers',
  '/dashboard/business-profile': 'Business Profile',
  '/dashboard/team': 'Team',
  '/dashboard/billing': 'Billing',
  '/dashboard/integrations': 'Integrations',
};

/** Which dashboard pages each Academy lesson is most relevant to. */
const LESSON_ROUTES: Record<string, string[]> = {
  welcome: ['/dashboard'],
  'business-profile': ['/dashboard/business-profile'],
  'call-forwarding': ['/dashboard/phone-numbers'],
  'first-test-call': ['/dashboard/calls'],
  'dispatch-board': ['/dashboard/dispatch', '/dashboard/jobs'],
  'price-book': ['/dashboard/price-book'],
  'reviews-memberships': ['/dashboard/customers'],
};

// ============================================================
// VIDEO LIBRARY (derived from the Academy)
// ============================================================

export function buildVideoLibrary(courses: AcademyCourse[]): HelpVideo[] {
  return courses.flatMap((course) =>
    course.lessons.map((lesson) => ({
      id: lesson.id,
      title: lesson.title,
      minutes: lesson.minutes,
      description: lesson.description,
      url: lesson.videoUrl,
      courseSlug: course.slug,
      courseTitle: course.title,
      routes: LESSON_ROUTES[lesson.id] ?? [],
    })),
  );
}

export const HELP_VIDEOS: HelpVideo[] = buildVideoLibrary(ACADEMY_COURSES);

export type VideoEmbedState = 'ok' | 'placeholder' | 'invalid';

const EMBED_HOSTS: { host: string; prefix: string }[] = [
  { host: 'www.youtube.com', prefix: '/embed/' },
  { host: 'www.youtube-nocookie.com', prefix: '/embed/' },
  { host: 'player.vimeo.com', prefix: '/video/' },
];

/** `placeholder` = Academy still has a REPLACE_ME url; `invalid` = not https or not an allowed embed host. */
export function videoEmbedState(url: string): VideoEmbedState {
  if (/REPLACE_ME/i.test(url)) return 'placeholder';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return 'invalid';
    return EMBED_HOSTS.some((h) => h.host === u.hostname && u.pathname.startsWith(h.prefix)) ? 'ok' : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** Serves YouTube through the privacy-enhanced domain (also the only YouTube host the CSP needs). */
export function toEmbedSrc(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'www.youtube.com') u.hostname = 'www.youtube-nocookie.com';
    return u.toString();
  } catch {
    return url;
  }
}

// ============================================================
// ROUTE CONTEXT
// ============================================================

/** Lower-cases, drops query/hash and trailing slashes. */
export function normalizePath(path: string): string {
  const clean = path.split(/[?#]/)[0].toLowerCase().replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

export function routeMatches(pathname: string, route: string): boolean {
  const p = normalizePath(pathname);
  const r = normalizePath(route);
  if (r === '/dashboard') return p === '/dashboard';
  return p === r || p.startsWith(`${r}/`);
}

/** Length of the most specific route that matches, or -1. */
function matchSpecificity(pathname: string, routes: string[]): number {
  let best = -1;
  for (const r of routes) {
    if (routeMatches(pathname, r)) best = Math.max(best, normalizePath(r).length);
  }
  return best;
}

export function contextualArticles(pathname: string, articles: HelpArticle[]): HelpArticle[] {
  return articles
    .map((a) => ({ a, s: matchSpecificity(pathname, a.routes) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => y.s - x.s)
    .map((x) => x.a);
}

export function contextualVideos(pathname: string, videos: HelpVideo[]): HelpVideo[] {
  return videos
    .map((v) => ({ v, s: matchSpecificity(pathname, v.routes) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => y.s - x.s)
    .map((x) => x.v);
}

export function pageLabel(pathname: string): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const [route, label] of Object.entries(HELP_PAGE_LABELS)) {
    if (routeMatches(pathname, route) && normalizePath(route).length > bestLen) {
      best = label;
      bestLen = normalizePath(route).length;
    }
  }
  return best;
}

/** Only real dashboard paths (and never the help page itself) may be used as context. */
export function isValidContextPath(path: string | null | undefined): path is string {
  if (!path) return false;
  const p = normalizePath(path);
  return p.startsWith('/dashboard') && !p.startsWith('/dashboard/help') && p.length <= 200 && /^[a-z0-9/_-]+$/.test(p);
}

const CONTEXT_KEY = 'vireek:last-dashboard-path';

/** Called from the dashboard nav on every navigation, so Help knows which page you came from. */
export function rememberDashboardPath(pathname: string): void {
  if (!isValidContextPath(pathname)) return;
  try {
    sessionStorage.setItem(CONTEXT_KEY, normalizePath(pathname));
  } catch {
    /* storage unavailable (private mode) — Help simply has no context */
  }
}

export function getRememberedDashboardPath(): string | null {
  try {
    const v = sessionStorage.getItem(CONTEXT_KEY);
    return isValidContextPath(v) ? v : null;
  } catch {
    return null;
  }
}

// ============================================================
// PERMISSIONS
// ============================================================

export function filterByPermission(
  articles: HelpArticle[],
  access: { isOwner: boolean; permissions: Partial<UserPermissions> },
): HelpArticle[] {
  return articles.filter((a) => !a.permission || access.isOwner || access.permissions[a.permission] === true);
}

// ============================================================
// SEARCH
// ============================================================

/** Lower-case, strip accents, collapse punctuation. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(query: string): string[] {
  return Array.from(new Set(fold(query).split(' ').filter((t) => t.length >= 2)));
}

export interface ArticleResult {
  article: HelpArticle;
  score: number;
}

/**
 * Every token must appear somewhere in the article (AND). Score favours the title, then keywords,
 * summary and body; whole-word hits outrank substring hits. Ties keep catalogue order.
 */
export function searchArticles(query: string, articles: HelpArticle[]): ArticleResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const results: ArticleResult[] = [];

  for (const article of articles) {
    const title = fold(article.title);
    const keywords = article.keywords.map(fold);
    const summary = fold(article.summary);
    const body = fold([...article.body, ...(article.steps ?? [])].join(' '));
    let total = 0;
    let allMatched = true;

    for (const t of tokens) {
      const word = new RegExp(`(^| )${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      let s = 0;
      if (title.includes(t)) s = Math.max(s, word.test(title) ? 12 : 8);
      if (keywords.some((k) => k.includes(t))) s = Math.max(s, keywords.some((k) => word.test(k)) ? 9 : 6);
      if (summary.includes(t)) s = Math.max(s, word.test(summary) ? 5 : 3);
      if (body.includes(t)) s = Math.max(s, word.test(body) ? 3 : 1);
      if (s === 0) {
        allMatched = false;
        break;
      }
      total += s;
    }
    if (allMatched) results.push({ article, score: total });
  }

  return results.sort((a, b) => b.score - a.score);
}

export function searchVideos(query: string, videos: HelpVideo[]): HelpVideo[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  return videos.filter((v) => {
    const hay = fold(`${v.title} ${v.description} ${v.courseTitle}`);
    return tokens.every((t) => hay.includes(t));
  });
}

export interface HighlightPart {
  text: string;
  match: boolean;
}

/** Splits text so matches can be wrapped in <mark> — rendered as React nodes, never as HTML. */
export function highlightParts(text: string, query: string): HighlightPart[] {
  const tokens = tokenize(query);
  if (tokens.length === 0 || !text) return [{ text, match: false }];
  const pattern = new RegExp(`(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text
    .split(pattern)
    .filter((s) => s !== '')
    .map((s) => ({ text: s, match: tokens.some((t) => fold(s) === t) }));
}

// ============================================================
// RECENT SEARCHES
// ============================================================

const RECENT_KEY = 'vireek:help-recent-searches';
export const MAX_RECENT = 5;

export function pushRecent(list: string[], query: string): string[] {
  const q = query.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (q.length < 2) return list;
  return [q, ...list.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENT);
}

export function loadRecentSearches(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function saveRecentSearches(list: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    /* ignore */
  }
}
