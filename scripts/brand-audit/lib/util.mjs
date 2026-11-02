// scripts/brand-audit/lib/util.mjs — small, dependency-free helpers shared by every check.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const toPosix = (p) => p.split(sep).join('/');
export const rel = (p) => toPosix(relative(ROOT, p));
export const exists = (p) => existsSync(join(ROOT, p));
export const read = (p) => readFileSync(join(ROOT, p), 'utf8');
export const tryRead = (p) => (exists(p) ? read(p) : null);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-home', '.git', 'coverage', '.lighthouseci', 'reports']);

export function* walk(dir, { exts = null, skipTests = false } = {}) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const full = join(abs, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(rel(full), { exts, skipTests });
    } else if ((!exts || exts.includes(extname(e.name))) && !(skipTests && /\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name))) {
      yield rel(full);
    }
  }
}

/**
 * Blank out comments (keeps line numbers) so commented-out code never counts.
 * `//` only starts a comment when not preceded by ':' so URLs in JSX text survive.
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  let str = null; // quote char when inside a string
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (str) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === str) str = null;
      else if (c === '\n' && str !== '`') str = null; // ' and " cannot span lines (JSX apostrophes)
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === '/' && n === '/' && src[i - 1] !== ':') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') str = c;
    out += c;
    i++;
  }
  return out;
}

export const flatKeys = (o, p = '') =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flatKeys(v, p ? `${p}.${k}` : k) : [p ? `${p}.${k}` : k]));

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export const slug = (route) => (route === '/' ? 'home' : route.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+$/, '')) || 'home';
export const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
export const pct = (num, den) => (den === 0 ? 100 : (100 * num) / den);
export const round1 = (n) => Math.round(n * 10) / 10;

/** Run an existing repo script and capture output without throwing. */
export async function runNode(args, { timeout = 180_000 } = {}) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: process.env });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr, out: stdout + stderr }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout, stderr: String(e), out: String(e) }); });
  });
}

/** Finding factory — one shape for every check and the crawler. */
export const finding = (o) => ({ severity: 'medium', refs: [], ...o });

/** Component-score helper: weighted mean over components that were actually measured (score !== null). */
export function combine(components) {
  const measured = components.filter((c) => c.score !== null && c.score !== undefined);
  if (!measured.length) return null;
  const w = measured.reduce((a, c) => a + c.weight, 0);
  return round1(measured.reduce((a, c) => a + c.score * c.weight, 0) / w);
}
