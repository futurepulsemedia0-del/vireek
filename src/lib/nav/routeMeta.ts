// Pure navigation helpers: breadcrumbs, active-state resolution, JSON-LD.
// No React / router / i18n imports so everything is unit-testable.

export interface Crumb {
  href: string;
  /** i18n key to translate (with `fallback` as defaultValue). */
  labelKey: string;
  fallback: string;
  /** True when the label came from `entityLabels` (already user data, not translatable). */
  dynamic: boolean;
  current: boolean;
}

export type CrumbOrEllipsis = Crumb | { ellipsis: true; hidden: Crumb[] };

const NON_BREADCRUMB_ROOTS = ['/dashboard', '/tech', '/staff', '/portal', '/admin', '/partner', '/supplier'];

/** Section roots whose first crumb should read "Dashboard", "Technician app", ... */
const ROOT_LABELS: Record<string, { key: string; fallback: string }> = {
  '/dashboard': { key: 'navflow.crumb.dashboard', fallback: 'Dashboard' },
  '/tech': { key: 'navflow.crumb.tech', fallback: 'Technician app' },
  '/staff': { key: 'navflow.crumb.staff', fallback: 'Staff' },
  '/portal': { key: 'navflow.crumb.portal', fallback: 'Customer portal' },
  '/admin': { key: 'navflow.crumb.admin', fallback: 'Admin' },
};

export function normalizePath(pathname: string): string {
  const clean = pathname.split(/[?#]/)[0] ?? '/';
  const trimmed = clean.length > 1 ? clean.replace(/\/+$/, '') : clean;
  return trimmed === '' ? '/' : trimmed;
}

export function isPublicPath(pathname: string): boolean {
  const p = normalizePath(pathname);
  return !NON_BREADCRUMB_ROOTS.some((r) => p === r || p.startsWith(`${r}/`));
}

const looksLikeId = (seg: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d{2,}$/.test(seg);

export function humanizeSegment(seg: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  })();
  const words = decoded.replace(/[-_]+/g, ' ').trim();
  return words.length === 0 ? decoded : words.charAt(0).toUpperCase() + words.slice(1);
}

export interface BuildCrumbsOptions {
  /** Map of absolute href -> entity name (customer name, job number, ...). */
  entityLabels?: Readonly<Record<string, string>>;
  /** Hrefs that exist as a visible parent but have no page of their own. */
  skipHrefs?: readonly string[];
}

export function buildBreadcrumbs(pathname: string, opts: BuildCrumbsOptions = {}): Crumb[] {
  const path = normalizePath(pathname);
  const segments = path.split('/').filter(Boolean);
  const crumbs: Crumb[] = [];
  const skip = new Set(opts.skipHrefs ?? []);
  let href = '';

  segments.forEach((seg, i) => {
    href += `/${seg}`;
    if (skip.has(href)) return;
    const entity = opts.entityLabels?.[href];
    const root = i === 0 ? ROOT_LABELS[href] : undefined;
    if (entity) {
      crumbs.push({ href, labelKey: '', fallback: entity, dynamic: true, current: false });
    } else if (root) {
      crumbs.push({ href, labelKey: root.key, fallback: root.fallback, dynamic: false, current: false });
    } else if (looksLikeId(seg)) {
      crumbs.push({ href, labelKey: 'navflow.crumb.details', fallback: 'Details', dynamic: false, current: false });
    } else {
      crumbs.push({ href, labelKey: `navflow.crumb.seg.${seg.toLowerCase()}`, fallback: humanizeSegment(seg), dynamic: false, current: false });
    }
  });

  if (crumbs.length > 0) crumbs[crumbs.length - 1] = { ...crumbs[crumbs.length - 1]!, current: true };
  // Public pages start with a Home crumb; app sections already start with their own root.
  if (isPublicPath(path) && path !== '/') {
    crumbs.unshift({ href: '/', labelKey: 'navflow.crumb.home', fallback: 'Home', dynamic: false, current: false });
  }
  return crumbs;
}

/** Collapse the middle of a long trail: first crumb, an ellipsis holding the rest, then the last `tail` crumbs. */
export function collapseCrumbs(crumbs: readonly Crumb[], maxVisible: number): CrumbOrEllipsis[] {
  const max = Math.max(3, maxVisible);
  if (crumbs.length <= max) return [...crumbs];
  const tail = max - 2;
  return [crumbs[0]!, { ellipsis: true, hidden: crumbs.slice(1, crumbs.length - tail) }, ...crumbs.slice(crumbs.length - tail)];
}

export function truncateLabel(label: string, max = 40): string {
  const chars = Array.from(label);
  return chars.length <= max ? label : `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}

export interface JsonLdCrumb {
  name: string;
  href: string;
}

export function buildBreadcrumbJsonLd(items: readonly JsonLdCrumb[], origin: string): Record<string, unknown> | null {
  if (items.length < 2) return null;
  const base = origin.replace(/\/+$/, '');
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: `${base}${c.href}`,
    })),
  };
}

export type NavCurrent = 'page' | 'true' | null;

/**
 * Resolve aria-current for a set of sibling nav items. The longest matching
 * item wins, so /dashboard/jobs/123 highlights "Jobs" (as an ancestor, `true`)
 * and never also "Dashboard". Exact match => `page`.
 */
export function resolveNavCurrent(
  items: readonly { path: string; end?: boolean }[],
  pathname: string,
): Map<string, NavCurrent> {
  const current = normalizePath(pathname);
  const result = new Map<string, NavCurrent>();
  let best: { path: string; exact: boolean } | null = null;
  for (const item of items) {
    const p = normalizePath(item.path);
    result.set(item.path, null);
    const exact = current === p;
    const prefix = !item.end && current.startsWith(p === '/' ? '/' : `${p}/`);
    if (!exact && !prefix) continue;
    if (!best || p.length > best.path.length) best = { path: item.path, exact };
  }
  if (best) result.set(best.path, best.exact ? 'page' : 'true');
  return result;
}
