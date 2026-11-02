/** Pure helpers behind the developer docs chrome: search index, page order (prev/next), versions, edit links. */
import {
  API_VERSION,
  ERROR_CATALOG,
  RESOURCES,
  WEBHOOK_EVENTS,
  listOperations,
} from '../../supabase/functions/api-v1/contract';

export type DocSection = 'Guides' | 'Endpoints' | 'Errors' | 'Webhooks';
export interface DocEntry {
  id: string;
  title: string;
  section: DocSection;
  href: string;
  /** Extra searchable words. */
  keywords: string;
}

const API_REF = '/developers/api-reference';

const GUIDES: DocEntry[] = [
  {
    id: 'g-quickstarts',
    title: 'Quickstarts: your first API call in 5 minutes',
    section: 'Guides',
    href: '/developers/quickstarts',
    keywords: 'getting started tutorial first call',
  },
  {
    id: 'g-auth',
    title: 'Authentication and API keys',
    section: 'Guides',
    href: '/docs#authentication',
    keywords: 'bearer token key scopes',
  },
  {
    id: 'g-keys',
    title: 'Manage keys: test and live mode, IP allowlist, rotation',
    section: 'Guides',
    href: '/dashboard/settings/api-keys',
    keywords: 'test live sandbox ip allowlist rotate revoke last used',
  },
  {
    id: 'g-rate',
    title: 'Rate limits and headers',
    section: 'Guides',
    href: `${API_REF}#errors`,
    keywords: 'throttle 429 retry-after x-ratelimit request id',
  },
  {
    id: 'g-page',
    title: 'Pagination and versioning policy',
    section: 'Guides',
    href: `${API_REF}#versioning`,
    keywords: 'cursor before next_before limit deprecation sunset breaking changes beta stable',
  },
  {
    id: 'g-sig',
    title: 'Verify webhook signatures',
    section: 'Webhooks',
    href: '/docs#webhooks',
    keywords: 'hmac sha256 signature secret whsec verify',
  },
  {
    id: 'g-retry',
    title: 'Webhook delivery, retries and idempotency',
    section: 'Webhooks',
    href: '/docs#webhooks',
    keywords: 'retry timeout dedupe duplicate redelivery',
  },
  {
    id: 'g-sandbox',
    title: 'Sandbox and Try it console',
    section: 'Guides',
    href: `${API_REF}#playground`,
    keywords: 'playground test key synthetic',
  },
  {
    id: 'g-logs',
    title: 'Request logs',
    section: 'Guides',
    href: `${API_REF}#logs`,
    keywords: 'audit latency status',
  },
  {
    id: 'g-sdk',
    title: 'TypeScript SDK, Postman and Insomnia collections',
    section: 'Guides',
    href: `${API_REF}#downloads`,
    keywords: 'client library openapi download',
  },
  {
    id: 'g-changelog',
    title: 'Developer changelog',
    section: 'Guides',
    href: '/developers/changelog',
    keywords: 'release notes updates breaking',
  },
];

export function buildDocsIndex(): DocEntry[] {
  const endpoints: DocEntry[] = listOperations().map((op) => ({
    id: `op-${op.id}`,
    title: `${op.method} ${op.path} — ${op.description}`,
    section: 'Endpoints',
    href: `${API_REF}#${op.resource}`,
    keywords: `${op.id} ${op.scope} ${op.resource}`,
  }));
  const fields: DocEntry[] = RESOURCES.map((r) => ({
    id: `obj-${r.name}`,
    title: `${r.schema} object fields`,
    section: 'Endpoints',
    href: `${API_REF}#${r.name}`,
    keywords: r.fields.map((f) => f.name).join(' '),
  }));
  const errors: DocEntry[] = ERROR_CATALOG.map((e) => ({
    id: `err-${e.code}`,
    title: `${e.code} (HTTP ${e.status})`,
    section: 'Errors',
    href: `${API_REF}#error-${e.code}`,
    keywords: `${e.cause} ${e.fix}`,
  }));
  const hooks: DocEntry[] = WEBHOOK_EVENTS.map((w) => ({
    id: `wh-${w.event}`,
    title: `${w.event} webhook${w.stability === 'beta' ? ' (Beta)' : ''}`,
    section: 'Webhooks',
    href: '/docs#webhooks',
    keywords: `${w.description} ${w.table}`,
  }));
  return [...GUIDES, ...endpoints, ...fields, ...errors, ...hooks];
}

/** Ranks by title match first (exact > prefix > word prefix > substring), then keywords. Every query word must match. */
export function searchDocs(index: readonly DocEntry[], query: string, limit = 8): DocEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: { e: DocEntry; score: number }[] = [];
  for (const e of index) {
    const title = e.title.toLowerCase();
    const hay = `${title} ${e.keywords.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    let score = 0;
    for (const w of words) {
      if (title === w) score += 100;
      else if (title.startsWith(w)) score += 40;
      else if (title.split(/[\s./:—()-]+/).some((t) => t.startsWith(w))) score += 25;
      else if (title.includes(w)) score += 15;
      else score += 5;
    }
    scored.push({ e, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.e.title.localeCompare(b.e.title))
    .slice(0, limit)
    .map((s) => s.e);
}

export const DOCS_PAGES = [
  { path: '/docs', title: 'Guides and webhooks' },
  { path: '/developers/quickstarts', title: 'Quickstarts' },
  { path: '/developers/api-reference', title: 'API reference' },
  { path: '/sandbox', title: 'Sandbox' },
  { path: '/developers/changelog', title: 'Changelog' },
] as const;

export function pagerFor(pathname: string): {
  prev: (typeof DOCS_PAGES)[number] | null;
  next: (typeof DOCS_PAGES)[number] | null;
} {
  const i = DOCS_PAGES.findIndex((p) => p.path === pathname.replace(/\/+$/, ''));
  if (i < 0) return { prev: null, next: null };
  return { prev: DOCS_PAGES[i - 1] ?? null, next: DOCS_PAGES[i + 1] ?? null };
}

export const API_VERSIONS = [
  { version: API_VERSION, label: `v${API_VERSION.split('.')[0]}`, status: 'current' as const },
];

/** "Edit this page" link; null when the repository URL is not configured (VITE_DOCS_REPO_URL), so no dead link is shown. */
export function editOnGithubUrl(
  repoUrl: string | undefined,
  file: string,
  branch = 'main',
): string | null {
  const base = repoUrl
    ?.trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  if (!base || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(base)) return null;
  return `${base}/edit/${branch}/${file.replace(/^\/+/, '')}`;
}
