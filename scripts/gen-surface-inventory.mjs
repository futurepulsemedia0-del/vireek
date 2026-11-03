#!/usr/bin/env node
// Product-surface inventory + link/consistency check. Source text only: nothing is executed or fetched.
// Usage: node scripts/gen-surface-inventory.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const manifest = JSON.parse(read('src/lib/surface/surface.manifest.json'));
const app = read('src/App.tsx');
const navSrc = read('src/components/DashboardNav.tsx');
const sitemap = fs.existsSync(path.join(root, 'public/sitemap.xml')) ? read('public/sitemap.xml') : '';

const norm = (h) => { let p = h.split(/[?#]/)[0].toLowerCase(); return p.length > 1 ? p.replace(/\/+$/, '') : p; };
const labs = manifest.labs.map(norm);
const rules = Object.entries(manifest.rules)
  .flatMap(([pillar, ps]) => ps.map((prefix) => ({ prefix: norm(prefix), pillar })))
  .sort((a, b) => b.prefix.length - a.prefix.length);
const classify = (h) => {
  const p = norm(h);
  if (labs.some((l) => p === l || p.startsWith(l + '/'))) return 'labs';
  const r = rules.find((x) => (x.prefix.endsWith('-') ? p.startsWith(x.prefix) : p === x.prefix || p.startsWith(x.prefix + '/') || p.startsWith(x.prefix + '-')));
  return r ? r.pillar : null;
};

// Routes
const routes = [...app.matchAll(/<Route\s+[^>]*?path="([^"]+)"/g)].map((m) => m[1]);
const routeRe = routes.map((r) => new RegExp('^' + r.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[^/]+/g, '[^/]+').replace(/\*/g, '.*') + '/?$'));
const routed = (h) => routeRe.some((re) => re.test(norm(h)));
const dupRoutes = routes.filter((r, i) => routes.indexOf(r) !== i);

// Nav items (label + href [+ permission])
const navItems = [...navSrc.matchAll(/\{\s*label:\s*'([^']+)',\s*href:\s*'([^']+)'([^}]*)\}/g)].map((m) => ({
  label: m[1], href: m[2],
  perm: (m[3].match(/requiresPermission:\s*'([^']+)'/) || [])[1] || (/ownerOnly:\s*true/.test(m[3]) ? 'owner' : ''),
}));
const byHref = new Map();
navItems.forEach((n) => byHref.set(norm(n.href), [...(byHref.get(norm(n.href)) || []), n]));

const jargon = /(mesh|graph|immune|entropy|causal|counterfactual|identity|twin|world model|reality|flywheel|autopilot|fabric|negative|regret|scientist|self-evolving|equilibrium|ledger|clearinghouse|physical economy|exchange|self-healing|autonomy|shield|compounding|prediction|simulator|debt|genome|atlas|constitution|uncertainty|unknowns|compiler|sandbox|reflexes|agent|\bOS\b|engine|intelligence|market maker|bottleneck|truth|loop|network)/i;
const jargonScore = (l) => Math.min(3, (l.match(new RegExp(jargon.source, 'gi')) || []).length);
const renames = new Map(manifest.renames.map((r) => [norm(r.href), r]));
const audience = (pillar, perm, href) => {
  const p = norm(href);
  if (manifest.technicianHomes.some((h) => norm(h) !== '/dashboard' && (p === norm(h) || p.startsWith(norm(h) + '/') || p.startsWith(norm(h) + '-')))) return 'technician;dispatcher;owner';
  if (perm === 'owner' || perm === 'can_view_billing' || perm === 'can_edit_business_profile') return 'owner';
  return pillar === 'settings' ? 'owner' : 'dispatcher;owner';
};

const rows = [];
for (const [href, items] of byHref) {
  if (href === '/dashboard') continue;
  const it = items[0];
  const pillar = classify(href);
  rows.push({
    route: it.href, current_label: [...new Set(items.map((i) => i.label))].join(' | '),
    new_label: renames.get(href)?.new || '', pillar: pillar || 'UNCLASSIFIED',
    maturity: pillar === 'labs' ? 'experimental' : 'core', audience: audience(pillar, it.perm, href),
    permission: it.perm, routed: routed(href) ? 'yes' : 'NO', in_sitemap: sitemap.includes(it.href) ? 'yes' : 'no',
    jargon: jargonScore(it.label), nav_duplicates: items.length > 1 ? items.length : '',
    plan: 'unchanged (gating not touched)', usage: 'n/a (no analytics export in repo)',
  });
}

const issues = [];
const unclassified = rows.filter((r) => r.pillar === 'UNCLASSIFIED');
if (unclassified.length) issues.push(`${unclassified.length} nav routes unclassified: ${unclassified.map((r) => r.route).join(' ')}`);
const unrouted = rows.filter((r) => r.routed === 'NO');
if (unrouted.length) issues.push(`${unrouted.length} nav links with no matching <Route>: ${unrouted.map((r) => r.route).join(' ')}`);
for (const r of manifest.renames) if (!routed(r.href)) issues.push(`rename target not routed: ${r.href}`);
for (const l of manifest.labs) if (!routed(l)) issues.push(`labs entry not routed: ${l}`);
const tie = rules.filter((r, i) => rules.findIndex((x) => x.prefix === r.prefix) !== i && rules.find((x) => x.prefix === r.prefix).pillar !== r.pillar);
if (tie.length) issues.push(`ambiguous prefixes in two pillars: ${tie.map((t) => t.prefix).join(' ')}`);
const newToHrefs = new Map();
manifest.renames.forEach((r) => newToHrefs.set(r.new, [...(newToHrefs.get(r.new) || []), r.href]));
const merges = [...newToHrefs].filter(([, h]) => h.length > 1);

const counts = {};
rows.forEach((r) => (counts[r.pillar] = (counts[r.pillar] || 0) + 1));
const summary = {
  routes: routes.length, uniqueRoutes: new Set(routes).size, duplicateRoutePaths: dupRoutes,
  navEntries: navItems.length, uniqueNavHrefs: byHref.size,
  duplicateNavHrefs: [...byHref].filter(([, v]) => v.length > 1).map(([h, v]) => `${h} x${v.length}`),
  jargonLabels3: rows.filter((r) => r.jargon >= 2).length, byPillar: counts, mergeCandidates: merges,
};
console.log(JSON.stringify(summary, null, 1));

const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
const cols = Object.keys(rows[0]);
fs.writeFileSync(path.join(root, 'docs/surface-inventory.csv'), [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
if (issues.length) { console.error('\nISSUES:\n- ' + issues.join('\n- ')); }
if (process.argv.includes('--check') && issues.length) process.exit(1);
