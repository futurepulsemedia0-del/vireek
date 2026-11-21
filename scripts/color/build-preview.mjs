#!/usr/bin/env node
// scripts/color/build-preview.mjs — `npm run tokens:preview`
// Generates docs/design/color-preview.html (all four themes: a sample UI + every token as a labelled swatch) from palette.mjs,
// so the preview can never drift from the real palette. `--check` fails if the file on disk is out of date (used by CI).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, buildTheme } from './palette.mjs';
import { toHex } from './oklch.mjs';

const OUT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'docs', 'design', 'color-preview.html');
const GROUPS = [
  ['Surfaces', /^(bg-|surface-|glass-bg)/], ['Text & lines', /^(text-|border-|on-inverse|focus-ring|selection|disabled|graphic-muted)/],
  ['Accent (Clay)', /^accent-|^on-accent/], ['CTA (Blurple)', /^cta-|^on-cta/], ['Success', /^success-|^on-success/], ['Danger', /^danger-|^on-danger/],
  ['Warning', /^warning-|^on-warning/], ['Info', /^info-|^on-info/], ['Brand & aurora', /^(brand-|on-brand|aurora-)/], ['Charts', /^viz-/],
];
const panel = (theme) => {
  const t = Object.fromEntries(Object.entries(buildTheme(theme).tok).filter(([, v]) => Array.isArray(v) && v.length === 3).map(([k, v]) => [k, toHex(v)]));
  const btn = (f, label) => `<button style="background:${t[f + '-fill']};color:${t['on-' + f]}">${label}</button>`;
  const used = new Set();
  const groups = GROUPS.map(([name, re]) => {
    const keys = Object.keys(t).filter((k) => re.test(k) && !used.has(k)); keys.forEach((k) => used.add(k));
    return `<h4>${name}</h4><div class="sw">${keys.map((k) => `<figure><i style="background:${t[k]}"></i><figcaption>${k}<br><code>${t[k]}</code></figcaption></figure>`).join('')}</div>`;
  }).join('');
  return `<section style="background:${t['bg-primary']};color:${t['text-primary']}"><h2 style="color:${t['text-secondary']}">${theme}</h2>
<div class="card" style="background:${t['bg-secondary']};border:1px solid ${t['border-default']}"><div class="row">${btn('accent', 'Book a call')}${btn('cta', '● Live')}${btn('success', 'Confirmed')}${btn('danger', 'Delete')}${btn('warning', 'Heads up')}${btn('info', 'Learn more')}</div>
<p style="color:${t['text-secondary']}">Secondary text · <span style="color:${t['text-muted']}">muted text</span> · <a style="color:${t['accent-text']}">accent link</a> · <span style="color:${t['danger-text']}">error text</span></p></div>${groups}</section>`;
};
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vireek colour system — preview</title>
<style>body{margin:0;font:14px/1.5 system-ui,sans-serif;background:#FAF9F5}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}section{padding:24px}
h2{margin:0 0 12px;text-transform:uppercase;letter-spacing:.08em;font-size:12px}h4{margin:18px 0 6px;font-size:12px;opacity:.75}.card{border-radius:12px;padding:14px}.row{display:flex;flex-wrap:wrap;gap:8px}
button{border:0;border-radius:999px;padding:8px 14px;font:600 13px system-ui}.card p{margin:10px 0 0}.sw{display:flex;flex-wrap:wrap;gap:8px}figure{margin:0;width:104px}
figure i{display:block;height:34px;border-radius:6px;border:1px solid rgba(128,128,128,.35)}figcaption{font-size:10px;line-height:1.3;margin-top:3px}code{font-size:10px}</style></head>
<body><main>${THEMES.map(panel).join('\n')}</main></body></html>
`;
if (process.argv.includes('--check')) {
  let disk = ''; try { disk = readFileSync(OUT, 'utf8'); } catch { /* missing */ }
  if (disk !== html) { console.error('✘ docs/design/color-preview.html is out of date — run: npm run tokens:preview'); process.exit(1); }
  console.log('✔ docs/design/color-preview.html is in sync with palette.mjs'); process.exit(0);
}
writeFileSync(OUT, html); console.log('✔ wrote docs/design/color-preview.html');
