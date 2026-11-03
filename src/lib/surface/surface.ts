import manifest from './surface.manifest.json';

export type PillarId = 'answer' | 'dispatch' | 'grow' | 'settings' | 'labs';
export type Audience = 'owner' | 'dispatcher' | 'technician';

interface Rename {
  href: string;
  old: string;
  new: string;
  synonyms: string[];
}

export const PILLARS = manifest.pillars as { id: PillarId; label: string; blurb: string }[];
export const PILLAR_ORDER: PillarId[] = PILLARS.map((p) => p.id);

/** Lowercase, decode, strip query/hash and trailing slash so matching is stable. */
export function normalizePath(href: string): string {
  let p = href.split(/[?#]/)[0] ?? '';
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep raw path */
  }
  p = p.toLowerCase();
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

const LABS = new Set(manifest.labs.map(normalizePath));

const RULES: { prefix: string; pillar: PillarId }[] = (
  Object.entries(manifest.rules) as [PillarId, string[]][]
)
  .flatMap(([pillar, prefixes]) => prefixes.map((prefix) => ({ prefix: normalizePath(prefix), pillar })))
  .sort((a, b) => b.prefix.length - a.prefix.length);

function matchesPrefix(p: string, prefix: string): boolean {
  if (prefix.endsWith('-')) return p.startsWith(prefix);
  return p === prefix || p.startsWith(`${prefix}/`) || p.startsWith(`${prefix}-`);
}

/** Labs (exact path or any sub-path) always wins; otherwise longest matching prefix; else null. */
export function pillarFor(href: string): PillarId | null {
  const p = normalizePath(href);
  for (const l of LABS) if (p === l || p.startsWith(`${l}/`)) return 'labs';
  for (const r of RULES) if (matchesPrefix(p, r.prefix)) return r.pillar;
  return null;
}

const RENAMES = new Map<string, Rename>(
  (manifest.renames as Rename[]).map((r) => [normalizePath(r.href), r]),
);

/** Plain-language label for a nav item. Falls back to the original label. */
export function plainLabel(href: string, fallback: string): string {
  return RENAMES.get(normalizePath(href))?.new ?? fallback;
}

/** Old name, new name and synonyms so renamed pages stay findable. */
export function searchTerms(href: string): string {
  const r = RENAMES.get(normalizePath(href));
  return r ? [r.old, r.new, ...r.synonyms].join(' ').toLowerCase() : '';
}

export function isLab(href: string): boolean {
  return pillarFor(href) === 'labs';
}

/** Audience from existing auth facts (there is no explicit dispatcher/technician role in AuthContext). */
export function audienceFor(isOwner: boolean, canViewAllJobs: boolean): Audience {
  if (isOwner) return 'owner';
  return canViewAllJobs ? 'dispatcher' : 'technician';
}

const TECH_HOMES = manifest.technicianHomes.map(normalizePath);

/** Technicians only see their own world; owners/dispatchers see everything their permissions allow. */
export function visibleToAudience(href: string, audience: Audience): boolean {
  if (audience !== 'technician') return true;
  const p = normalizePath(href);
  if (p === '/dashboard') return true;
  return TECH_HOMES.some((h) => h !== '/dashboard' && (p === h || p.startsWith(`${h}/`) || p.startsWith(`${h}-`)));
}

export interface PillarItem {
  href: string;
  label: string;
}

/** Groups already-permission-filtered items into pillars. Labs are included only when `showLabs`. De-dupes by href. */
export function groupByPillar<T extends PillarItem>(
  items: T[],
  opts: { audience: Audience; showLabs: boolean },
): { pillar: PillarId; items: T[] }[] {
  const seen = new Set<string>();
  const buckets = new Map<PillarId, T[]>(PILLAR_ORDER.map((id) => [id, []]));
  for (const it of items) {
    const key = normalizePath(it.href);
    if (seen.has(key) || key === '/dashboard') continue;
    seen.add(key);
    if (!visibleToAudience(it.href, opts.audience)) continue;
    const pillar = pillarFor(it.href) ?? 'settings';
    if (pillar === 'labs' && !opts.showLabs) continue;
    buckets.get(pillar)!.push(it);
  }
  return PILLAR_ORDER.map((pillar) => ({ pillar, items: buckets.get(pillar)! })).filter((g) => g.items.length > 0);
}
