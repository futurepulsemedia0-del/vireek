#!/usr/bin/env node
// Static PWA/brand check (Lighthouse removed its PWA category in v12, so installability is verified here).
// Usage: node scripts/brand/check-pwa.mjs [--root <dir>]   (default: repo root; reads public/ and index.html)
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HEX = /^#[0-9a-f]{6}$/i;
const BANNED_COLORS = ['#4F46E5', '#FFFFFF', '#FFF'];

function pngDims(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

/** Pure. `read(src)` returns a Buffer for a public path ("/icons/x.png") or null. */
export function checkManifest(m, html, read) {
  const errs = [];
  const need = (cond, msg) => cond || errs.push(msg);
  const str = (v) => typeof v === 'string' && v.trim().length > 0;

  need(str(m.name), 'name missing');
  need(str(m.short_name) && m.short_name.length <= 12, 'short_name missing or longer than 12 chars');
  need(str(m.description) && m.description.length >= 40, 'description missing or too short (<40 chars)');
  need(str(m.id) && m.id.startsWith('/'), 'id must be a stable path like "/dashboard"');
  need(str(m.scope) && str(m.start_url) && new URL(m.start_url, 'https://x.test').pathname.startsWith(m.scope), 'start_url must be inside scope');
  need(['standalone', 'fullscreen', 'minimal-ui'].includes(m.display), 'display must be standalone/fullscreen/minimal-ui');
  need(Array.isArray(m.display_override) && m.display_override.length > 0 && m.display_override.includes(m.display), 'display_override must list display');
  need(m.launch_handler && Array.isArray(m.launch_handler.client_mode), 'launch_handler.client_mode missing');
  for (const k of ['theme_color', 'background_color']) {
    need(HEX.test(m[k] ?? ''), `${k} must be #RRGGBB`);
    need(!BANNED_COLORS.includes(String(m[k]).toUpperCase()), `${k} is a banned legacy color (${m[k]})`);
  }
  need(Array.isArray(m.categories) && m.categories.length > 0, 'categories missing');

  const checkFile = (what, item) => {
    const buf = read(item.src);
    if (!buf) return errs.push(`${what}: file not found ${item.src}`);
    const real = pngDims(buf);
    if (!real) return errs.push(`${what}: ${item.src} is not a PNG`);
    if (real !== item.sizes) errs.push(`${what}: ${item.src} is ${real}, manifest says ${item.sizes}`);
  };
  const icons = m.icons ?? [];
  icons.forEach((i) => checkFile('icon', i));
  const has = (purpose, size) => icons.some((i) => i.purpose === purpose && i.sizes === size);
  need(has('any', '192x192') && has('any', '512x512'), 'need purpose "any" icons at 192x192 and 512x512');
  need(icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'), 'need a dedicated 512x512 maskable icon');
  need(icons.some((i) => i.purpose === 'monochrome'), 'need a monochrome icon');
  need(!icons.some((i) => /\bany\b/.test(i.purpose ?? '') && /maskable/.test(i.purpose ?? '')), 'never combine "any maskable" in one icon');
  need(new Set(icons.map((i) => i.src)).size === icons.length, 'same file used for several icon entries');

  const shots = m.screenshots ?? [];
  for (const form of ['wide', 'narrow']) need(shots.some((s) => s.form_factor === form), `need at least one ${form} screenshot`);
  for (const s of shots) {
    checkFile('screenshot', s);
    const [w, h] = String(s.sizes).split('x').map(Number);
    need(w >= 320 && h >= 320 && w <= 3840 && h <= 3840 && Math.max(w / h, h / w) <= 2.3, `screenshot ${s.src}: size/aspect outside Chrome limits`);
    need(str(s.label), `screenshot ${s.src}: label missing`);
  }

  const sc = m.shortcuts ?? [];
  need(sc.length > 0 && sc.length <= 4, 'need 1-4 shortcuts');
  const shortcutIcons = sc.map((s) => s.icons?.[0]?.src);
  need(new Set(shortcutIcons).size === sc.length && !shortcutIcons.includes(undefined), 'each shortcut needs its own distinct icon');
  for (const s of sc) {
    need(str(s.name) && str(s.url) && s.url.startsWith(m.scope ?? '/'), `shortcut ${s.name}: name/url invalid`);
    (s.icons ?? []).forEach((i) => checkFile(`shortcut ${s.name}`, i));
  }

  need(/<link[^>]+rel="manifest"/i.test(html), 'index.html has no <link rel="manifest">');
  need(/<meta[^>]+name="theme-color"/i.test(html), 'index.html has no theme-color meta');
  need(!/#4F46E5/i.test(html), 'index.html still contains legacy #4F46E5');
  need(/rel="apple-touch-icon"/i.test(html), 'index.html has no apple-touch-icon');
  return errs;
}

function main() {
  const i = process.argv.indexOf('--root');
  const root = i > -1 ? path.resolve(process.argv[i + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const mp = path.join(root, 'public/site.webmanifest');
  if (!existsSync(mp)) {
    console.error(`[pwa] ${mp} not found`);
    process.exit(1);
  }
  const read = (src) => {
    const f = path.join(root, 'public', src.split('?')[0]);
    return f.startsWith(path.join(root, 'public') + path.sep) && existsSync(f) ? readFileSync(f) : null;
  };
  const errs = checkManifest(JSON.parse(readFileSync(mp, 'utf8')), readFileSync(path.join(root, 'index.html'), 'utf8'), read);
  if (errs.length) {
    console.error(`[pwa] ${errs.length} problem(s):\n  - ${errs.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('[pwa] OK - manifest, icons, screenshots, shortcuts and index.html pass.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
