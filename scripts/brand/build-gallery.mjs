#!/usr/bin/env node
// Local preview gallery (not shipped): every OG card by page type, PWA icons with maskable safe-zone overlays,
// install screenshots, and a Chrome-style install card driven by the real manifest. Open .brand-preview/index.html.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const out = path.join(ROOT, '.brand-preview');
const rel = (p) => path.relative(out, p).split(path.sep).join('/');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'public/site.webmanifest'), 'utf8'));
const ogManifestPath = path.join(ROOT, 'dist/og/_manifest.json');
const cards = existsSync(ogManifestPath) ? JSON.parse(readFileSync(ogManifestPath, 'utf8')).cards : [];
const byKind = Object.groupBy ? Object.groupBy(cards, (c) => c.kind) : cards.reduce((a, c) => ((a[c.kind] ??= []).push(c), a), {});

const ogSection = Object.entries(byKind).map(([kind, list]) =>
  `<h3>${esc(kind)} (${list.length})</h3><div class="grid">${list.slice(0, 12).map((c) =>
    `<figure><img loading="lazy" src="${rel(path.join(ROOT, 'dist', c.og))}" width="400"><figcaption>${esc(c.path)}<br>${esc(c.title)}</figcaption></figure>`).join('')}</div>`).join('') ||
  '<p>No dist/og yet. Run npm run build first.</p>';

const icons = manifest.icons.map((i) => {
  const src = rel(path.join(ROOT, 'public', i.src));
  const m = i.purpose === 'maskable';
  return `<figure><div class="chk" style="width:128px;height:128px;position:relative">${
    m ? `<img src="${src}" width="128" style="clip-path:circle(50%)"><span class="safe"></span>` : `<img src="${src}" width="128">`}</div>` +
    `<figcaption>${esc(i.purpose)} ${esc(i.sizes)}${m ? '<br>circle mask + 80% safe zone' : ''}</figcaption></figure>`;
}).join('');
const shots = (manifest.screenshots ?? []).map((s) =>
  `<figure><img src="${rel(path.join(ROOT, 'public', s.src))}" height="${s.form_factor === 'wide' ? 220 : 380}"><figcaption>${esc(s.form_factor)}: ${esc(s.label)}</figcaption></figure>`).join('');
const install = `<div class="install"><img src="${rel(path.join(ROOT, 'public', manifest.icons[0].src))}" width="64"><div><b>${esc(manifest.name)}</b><br><small>${esc(manifest.description)}</small></div></div>`;
const kitDir = path.join(ROOT, 'public/brand-kit');
const kit = existsSync(kitDir) ? readdirSync(kitDir).filter((f) => f.endsWith('.png')).map((f) =>
  `<figure><img loading="lazy" src="${rel(path.join(kitDir, f))}" style="max-width:360px;max-height:200px"><figcaption>${esc(f)}</figcaption></figure>`).join('') : '';

await mkdir(out, { recursive: true });
await writeFile(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Vireek brand preview</title>
<style>body{font:14px system-ui;margin:24px;background:#FDFCFA;color:#17171A}h2{margin-top:40px}.grid{display:flex;flex-wrap:wrap;gap:16px}figure{margin:0}figcaption{font-size:12px;color:#676770;max-width:400px}
.chk{background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0/16px 16px}.safe{position:absolute;inset:10%;border:2px dashed #D6582A;border-radius:50%}
.install{display:flex;gap:16px;align-items:center;padding:16px;border-radius:16px;background:#fff;box-shadow:0 2px 12px #0002;max-width:420px}img{border-radius:6px}</style>
<h1>Vireek brand preview</h1><h2>PWA install card</h2>${install}<h2>Install screenshots</h2><div class="grid">${shots}</div>
<h2>PWA icons (dashed ring = 80% safe zone)</h2><div class="grid">${icons}</div>
<h2>Open Graph cards by page type</h2>${ogSection}<h2>Brand kit</h2><div class="grid">${kit}</div>`);
console.log(`[gallery] ${path.relative(ROOT, path.join(out, 'index.html'))}`);
