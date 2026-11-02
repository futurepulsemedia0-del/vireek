// checks/mobile.mjs — mobile/PWA polish (static). Runtime tap-target + overflow evidence comes from the crawler at 375px.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, walk, stripComments, tryRead, exists, finding, round1 } from '../lib/util.mjs';

export function manifestChecks(m) {
  const icons = m.icons ?? [];
  const has = (size, purpose) => icons.some((i) => i.sizes === size && (i.purpose ?? 'any').split(' ').includes(purpose));
  return [
    ['name + short_name', Boolean(m.name && m.short_name)],
    ['start_url + scope', Boolean(m.start_url && m.scope)],
    ['display standalone/fullscreen', ['standalone', 'fullscreen'].includes(m.display)],
    ['theme_color + background_color', Boolean(m.theme_color && m.background_color)],
    ['192 + 512 icons', has('192x192', 'any') && has('512x512', 'any')],
    ['maskable icon', has('512x512', 'maskable')],
    ['description', Boolean(m.description)],
    ['shortcuts', (m.shortcuts ?? []).length > 0],
  ];
}

export async function run() {
  const findings = [];
  const components = [];
  let manifest = {};
  try { manifest = JSON.parse(tryRead('public/site.webmanifest') ?? '{}'); } catch { /* reported below */ }
  const mc = manifestChecks(manifest);
  components.push({ name: 'Web app manifest completeness', weight: 30, score: round1((100 * mc.filter(([, p]) => p).length) / mc.length), detail: mc.map(([n, p]) => `${p ? '✓' : '✗'} ${n}`).join(' · ') });
  mc.filter(([, p]) => !p).forEach(([n]) => findings.push(finding({ id: 'mobile/manifest', category: 'mobile', severity: 'medium', title: `Manifest: ${n} missing`, refs: [{ file: 'public/site.webmanifest' }], count: 1 })));

  const html = tryRead('index.html') ?? '';
  const meta = [['viewport-fit=cover', /viewport-fit=cover/.test(html)], ['apple-touch-icon', /apple-touch-icon/.test(html)], ['apple-mobile-web-app-title', /apple-mobile-web-app-title/.test(html)]];
  components.push({ name: 'index.html mobile meta', weight: 15, score: round1((100 * meta.filter(([, p]) => p).length) / meta.length), detail: meta.map(([n, p]) => `${p ? '✓' : '✗'} ${n}`).join(' · ') });

  let vh = 0; let dvh = 0; let safe = 0;
  for (const f of walk('src', { exts: ['.tsx', '.ts', '.css'], skipTests: true })) {
    const s = stripComments(readFileSync(join(ROOT, f), 'utf8'));
    vh += (s.match(/\b(?:min-h|h|max-h)-screen\b|\b(?:min-)?height:\s*100vh/g) ?? []).length;
    dvh += (s.match(/\b(?:min-h|h|max-h)-\[100dvh\]|\b(?:min-)?height:\s*100dvh|\bh-dvh\b|\bmin-h-dvh\b/g) ?? []).length;
    safe += (s.match(/safe-area-inset|\bsafe-(?:top|bottom)\b|pb-safe|pt-safe/g) ?? []).length;
  }
  const dvhShare = vh + dvh === 0 ? 100 : (100 * dvh) / (vh + dvh);
  components.push({ name: 'Mobile viewport units: dvh vs 100vh/h-screen', weight: 20, score: round1(dvhShare), detail: `${dvh} dvh vs ${vh} vh/h-screen (100vh jumps under mobile browser chrome)` });
  if (vh) findings.push(finding({ id: 'mobile/vh', category: 'mobile', severity: 'low', title: `${vh} uses of 100vh/h-screen — prefer dvh on mobile`, refs: [{ file: 'src/' }], count: vh }));
  components.push({ name: 'Safe-area insets handled (notch / home indicator)', weight: 15, score: safe > 0 ? 100 : 0, detail: `${safe} safe-area usages` });

  const cap = tryRead('capacitor.config.ts') ?? '';
  const nativePipe = [['capacitor config', Boolean(cap)], ['native asset generator', exists('scripts/make-native-assets.mjs')], ['mobile preflight', exists('scripts/mobile-preflight.mjs')], ['release doc', exists('docs/MOBILE_RELEASE.md')], ['mobile CI workflow', exists('.github/workflows/mobile.yml')]];
  components.push({ name: 'Native pipeline (assets, preflight, docs, CI)', weight: 20, score: round1((100 * nativePipe.filter(([, p]) => p).length) / nativePipe.length), detail: nativePipe.map(([n, p]) => `${p ? '✓' : '✗'} ${n}`).join(' · ') });
  const splash = /SplashScreen:[^}]*backgroundColor:\s*'(#[0-9a-fA-F]{6})'/.exec(cap)?.[1];
  if (splash) findings.push(finding({ id: 'mobile/splash-color', category: 'mobile', severity: 'info', title: `Capacitor splash/background is ${splash} (dark theme bg token is #090A0D; light is #FDFCFA)`, detail: 'Pure black differs from both themes and can flash on launch.', refs: [{ file: 'capacitor.config.ts' }], count: 1 }));
  return { category: 'mobile', components, metrics: { vh, dvh, safe }, findings };
}
