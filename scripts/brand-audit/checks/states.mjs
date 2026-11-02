// scripts/brand-audit/checks/states.mjs
//
// UX state coverage — STATIC HEURISTIC. For every page that loads data, does the source show a loading
// state, an empty state and an error state? (Disabled / success / offline are reported separately.)
// The crawler adds runtime evidence (stuck loaders, error boundaries, console errors). Heuristics can
// miss shared wrappers, so treat the per-page list as a review queue, not a verdict.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, walk, stripComments, finding, pct, round1 } from '../lib/util.mjs';

export const SIGNALS = {
  data: /from ['"]@\/lib\/supabase['"]|supabase\s*\.\s*(from|rpc|functions)|\buseQuery\b|\bfetch\(|use[A-Z]\w*(?:Data|Query|List|Rows)\(/,
  loading: /\bSkeleton\w*\b|<Loader2|\bisLoading\b|\bloading\b\s*(?:\?|&&|\)|\}|=)|aria-busy|\bSpinner\b|\bPageLoader\b/,
  empty: /\bEmptyState\b|\.length\s*===?\s*0|!\s*\w+(?:\.\w+)*\.length\b|\bNo [a-z][\w ]{2,40} (?:yet|found)\b/,
  error: /\bErrorState\b|\bErrorBanner\b|role=["']alert["']|\bsetError\(|\bisError\b|toast\.error|toast\([^)]*,\s*['"](?:error|danger)['"]|toast\(\{[^}]*(?:error|danger|fail)|variant:\s*['"](?:error|danger)['"]|\bloadError\b|\bsetStatus\(\s*['"]error['"]|===?\s*['"](?:error|failed)['"]|\berror\s*(?:\?|&&)\s*\(?\s*<|\btext-(?:error|danger)(?:-\d+)?\b/,
  success: /\btoast\.success|toast\([^)]*,\s*['"]success['"]|\bsuccess[A-Z]\w*\b|variant:\s*['"]success['"]|===?\s*['"](?:ok|success|saved)['"]/,
  disabled: /\bdisabled\b|\bdisabledReason\b|aria-disabled/,
};

/** Pure: classify one page's source. */
export function classifyPage(src) {
  const code = stripComments(src);
  const r = Object.fromEntries(Object.entries(SIGNALS).map(([k, re]) => [k, re.test(code)]));
  // A page that handles an `error` value in 4+ places is treated as having an error path even if the idiom is unusual.
  if (!r.error && (code.match(/\berror\b/gi) ?? []).length >= 4) r.error = true;
  return { ...r, isData: r.data };
}

export async function run() {
  const pages = [...walk('src/pages', { exts: ['.tsx'], skipTests: true })].filter((f) => !f.includes('/dev/'));
  const dataPages = [];
  const missing = { loading: [], empty: [], error: [] };
  let withSuccess = 0;
  for (const f of pages) {
    const c = classifyPage(readFileSync(join(ROOT, f), 'utf8'));
    if (!c.isData) continue;
    dataPages.push(f);
    if (c.success) withSuccess++;
    for (const k of ['loading', 'empty', 'error']) if (!c[k]) missing[k].push(f);
  }
  const n = dataPages.length;
  const cov = (k) => round1(pct(n - missing[k].length, n));

  const offlineArtifacts = ['public/offline.html', 'public/offline.js', 'public/sw.js'].filter((p) => existsSync(join(ROOT, p)));
  let onlineHook = false;
  for (const f of walk('src', { exts: ['.ts', '.tsx'], skipTests: true })) {
    if (/navigator\.onLine|addEventListener\(['"]offline['"]/.test(readFileSync(join(ROOT, f), 'utf8'))) { onlineHook = true; break; }
  }
  const offlineScore = Math.round(((offlineArtifacts.length / 3) * 0.6 + (onlineHook ? 0.4 : 0)) * 100);

  const components = [
    { name: 'Data pages with a loading state', weight: 30, score: cov('loading'), detail: `${n - missing.loading.length}/${n}` },
    { name: 'Data pages with an empty state', weight: 25, score: cov('empty'), detail: `${n - missing.empty.length}/${n}` },
    { name: 'Data pages with a user-visible error state', weight: 30, score: cov('error'), detail: `${n - missing.error.length}/${n}` },
    { name: 'Offline handling (offline page, service worker, online/offline listener)', weight: 15, score: offlineScore, detail: `${offlineArtifacts.length}/3 artifacts, in-app listener: ${onlineHook ? 'yes' : 'no'}` },
  ];
  const findings = [];
  for (const [k, sev] of [['loading', 'medium'], ['empty', 'medium'], ['error', 'high']]) {
    if (missing[k].length) findings.push(finding({ id: `states/missing-${k}`, category: 'states', severity: sev, title: `${missing[k].length} data page(s) show no ${k} state (static heuristic)`, detail: k === 'loading' ? 'Use the Skeleton family (@/components/Skeleton).' : k === 'empty' ? 'Use <EmptyState> (@/components/EmptyState).' : 'Render a visible error with a next step (docs/voice-and-tone.md), not just console.error.', refs: missing[k].slice(0, 200).map((file) => ({ file })), count: missing[k].length }));
  }
  if (!onlineHook) findings.push(finding({ id: 'states/no-offline-ui', category: 'states', severity: 'medium', title: 'No in-app offline indicator found', detail: 'Add a banner driven by navigator.onLine + online/offline events (feedback level 3 in docs/INTERACTION_STATES.md).', refs: [{ file: 'src/' }], count: 1 }));
  return { category: 'states', components, metrics: { pages: pages.length, dataPages: n, missingLoading: missing.loading.length, missingEmpty: missing.empty.length, missingError: missing.error.length, pagesWithSuccessFeedback: withSuccess, offlineArtifacts: offlineArtifacts.length, onlineHook }, findings };
}
