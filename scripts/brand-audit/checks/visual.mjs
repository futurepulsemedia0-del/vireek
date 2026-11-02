// checks/visual.mjs — visual identity (static): brand assets, icon library, motion tokens, fonts, brand-color consistency.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, walk, stripComments, tryRead, exists, finding, pct, round1 } from '../lib/util.mjs';

/** Pure: "R G B" token -> #RRGGBB */
export const rgbTripletToHex = (t) => `#${t.trim().split(/\s+/).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

export function brandAccent() {
  const css = tryRead('src/index.css') ?? '';
  const m = /--accent-primary:\s*([\d\s]+);/.exec(css);
  return m ? rgbTripletToHex(m[1]) : null;
}

export async function run() {
  const findings = [];
  const components = [];
  const assets = ['public/favicon.svg', 'public/favicon.ico', 'public/favicon-96x96.png', 'public/apple-touch-icon.png', 'public/web-app-manifest-192x192.png', 'public/web-app-manifest-512x512.png', 'public/og-image.png', 'src/components/brand/Logo.tsx'];
  const missing = assets.filter((a) => !exists(a));
  components.push({ name: 'Brand asset set present', weight: 15, score: round1(pct(assets.length - missing.length, assets.length)), detail: missing.length ? `missing: ${missing.join(', ')}` : 'all present' });
  missing.forEach((m) => findings.push(finding({ id: 'visual/asset-missing', category: 'visual', severity: 'high', title: `Brand asset missing: ${m}`, refs: [{ file: m }], count: 1 })));

  let iconOther = []; let rawDuration = []; let motionFiles = 0; let fontHits = []; let logoImg = [];
  for (const f of walk('src', { exts: ['.ts', '.tsx'], skipTests: true })) {
    if (f.startsWith('src/pages/dev/') || f.startsWith('src/components/brand/')) continue;
    const src = stripComments(readFileSync(join(ROOT, f), 'utf8'));
    if (/from ['"](react-icons|@heroicons|@fortawesome|@phosphor-icons|@tabler|@radix-ui\/react-icons)/.test(src)) iconOther.push(f);
    if (/\b(?:duration|transition)\b[^\n]{0,40}\bduration:\s*[\d.]+/.test(src) || /\bduration:\s*0?\.\d+/.test(src)) {
      motionFiles++;
      if (!/@\/lib\/motion|ease:\s*EASE|--vrk-/.test(src)) rawDuration.push(f);
    }
    if (/font-\['|fontFamily:\s*['"`]/.test(src) && !/pdf/i.test(f)) fontHits.push(f);
    if (/<img[^>]+src=["'][^"']*logo[^"']*["']/i.test(src) && !/components\/(brand|Logo)/.test(f)) logoImg.push(f);
  }
  components.push({ name: 'One icon system (lucide-react only)', weight: 20, score: Math.max(0, 100 - 25 * iconOther.length), detail: `${iconOther.length} files import another icon library` });
  if (iconOther.length) findings.push(finding({ id: 'visual/icons', category: 'visual', severity: 'medium', title: `${iconOther.length} files use a second icon library`, refs: iconOther.map((file) => ({ file })), count: iconOther.length }));
  components.push({ name: 'Motion uses shared tokens (@/lib/motion EASE / --vrk-*)', weight: 25, score: round1(pct(motionFiles - rawDuration.length, motionFiles)), detail: `${rawDuration.length}/${motionFiles} animated files hard-code duration/ease (BRAND_MOTION.md)` });
  if (rawDuration.length) findings.push(finding({ id: 'visual/motion-tokens', category: 'visual', severity: 'low', title: `${rawDuration.length} files hard-code motion timing instead of tokens`, detail: 'Use EASE from @/lib/motion and the duration scale in BRAND_MOTION.md.', refs: rawDuration.slice(0, 200).map((file) => ({ file })), count: rawDuration.length }));
  components.push({ name: 'Typography: no per-component font-family overrides', weight: 20, score: Math.max(0, 100 - 25 * fontHits.length), detail: `${fontHits.length} files override font-family` });
  if (fontHits.length) findings.push(finding({ id: 'visual/fonts', category: 'visual', severity: 'medium', title: `${fontHits.length} files override the font stack`, refs: fontHits.map((file) => ({ file })), count: fontHits.length }));
  components.push({ name: 'Logo only via <Logo>', weight: 5, score: Math.max(0, 100 - 25 * logoImg.length), detail: `${logoImg.length} raw <img> logo usages` });
  if (logoImg.length) findings.push(finding({ id: 'visual/logo', category: 'visual', severity: 'medium', title: `${logoImg.length} raw logo <img> usages bypass <Logo>`, refs: logoImg.map((file) => ({ file })), count: logoImg.length }));

  // Brand-color consistency: PWA/theme colors vs the token accent
  const accent = brandAccent();
  const manifest = JSON.parse(tryRead('public/site.webmanifest') ?? '{}');
  const themeMeta = /name="theme-color"\s+content="(#[0-9a-fA-F]{6})"/.exec(tryRead('index.html') ?? '')?.[1]?.toUpperCase();
  const mismatches = [];
  if (accent) {
    if (manifest.theme_color && manifest.theme_color.toUpperCase() !== accent) mismatches.push(`site.webmanifest theme_color ${manifest.theme_color} ≠ accent ${accent}`);
    if (themeMeta && themeMeta !== accent) mismatches.push(`index.html theme-color ${themeMeta} ≠ accent ${accent}`);
  }
  components.push({ name: 'PWA/theme colors match the brand accent token', weight: 15, score: accent ? (mismatches.length ? 0 : 100) : null, detail: accent ? (mismatches.join('; ') || 'match') : 'accent token not found' });
  mismatches.forEach((m) => findings.push(finding({ id: 'visual/theme-color', category: 'visual', severity: 'medium', title: m, detail: 'Single source: --accent-primary in src/index.css.', refs: [{ file: 'public/site.webmanifest' }, { file: 'index.html' }], count: 1 })));
  return { category: 'visual', components, metrics: { accent, manifestTheme: manifest.theme_color, htmlTheme: themeMeta, motionFiles }, findings };
}
