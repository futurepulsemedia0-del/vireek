// src/lib/navActive.ts
//
// Decides which sidebar item is "current". The old check was `pathname.startsWith(href)`, which highlighted several
// items at once (e.g. Call History AND Call Flows on /dashboard/calls/flows). Here an item is active only when it is
// the MOST SPECIFIC nav entry that matches the path, so exactly one item is highlighted.

const clean = (value: string): string => {
  const path = (value.split(/[?#]/)[0] ?? '').toLowerCase();
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
};

const covers = (path: string, href: string): boolean => path === href || path.startsWith(`${href}/`);

export function isNavItemActive(pathname: string, href: string, allHrefs: readonly string[]): boolean {
  const path = clean(pathname);
  const self = clean(href);
  if (self === '/dashboard') return path === '/dashboard';
  // Settings also owns its account sub-route (kept from the previous behaviour).
  if (self === '/dashboard/settings' && path === '/dashboard/settings/account') return true;
  if (!covers(path, self)) return false;
  // A longer nav entry that also matches wins; this one steps aside.
  return !allHrefs.some((other) => {
    const o = clean(other);
    return o.length > self.length && covers(path, o);
  });
}
