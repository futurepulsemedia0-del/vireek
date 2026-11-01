import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { pageTitle } from '@/lib/brand/brandConfig';
import { stripTabPrefix } from '@/lib/brand/tabIdentity';

/** Authenticated app areas. Public marketing pages set their own titles through useSEO. */
const APP_ROOTS = ['/dashboard', '/tech', '/staff', '/partner-portal', '/onboarding'];
const ROOT_LABELS: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/tech': 'Technician',
  '/staff': 'Staff',
  '/partner-portal': 'Partner portal',
  '/onboarding': 'Onboarding',
};
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{16,})$/i;
const STATIC_TITLE = typeof document === 'undefined' ? '' : stripTabPrefix(document.title);
let lastApplied = '';

/** "/dashboard/team/org-chart" -> "Org chart"; null for anything outside the app areas. */
export function routeLabel(pathname: string): string | null {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (!APP_ROOTS.some((r) => p === r || p.startsWith(`${r}/`))) return null;
  if (ROOT_LABELS[p]) return ROOT_LABELS[p];
  const last = p.split('/').filter((s) => s && !ID_SEGMENT.test(s)).pop();
  if (!last) return null;
  let text = last;
  try {
    text = decodeURIComponent(last);
  } catch {
    /* keep raw segment */
  }
  const words = text.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

/**
 * Sets "<Page> · Vireek" on app routes. A page that sets its own title (Help, Changelog...) wins:
 * we only write when the current title is blank, the static index.html title, or one we wrote.
 */
export function RouteTitle(): null {
  const { pathname } = useLocation();
  useEffect(() => {
    const label = routeLabel(pathname);
    if (!label) return;
    const current = stripTabPrefix(document.title);
    const ours = current === lastApplied || current.endsWith(' \u00B7 Vireek');
    if (current !== '' && current !== STATIC_TITLE && !ours) return;
    lastApplied = pageTitle(label);
    document.title = lastApplied;
  }, [pathname]);
  return null;
}
