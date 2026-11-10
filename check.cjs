const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { createRequire } = require('module');

let esb;
try {
  esb = createRequire(path.join(process.cwd(), 'package.json'))('esbuild');
} catch {
  console.log('esbuild not found. Run: npm install');
  process.exit(1);
}

const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.json', '.css', '/index.ts', '/index.tsx', '/index.js'];

const isFile = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

const sh = (c) => {
  try {
    return cp.execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1e8 }).trim();
  } catch {
    return '';
  }
};

const loaderOf = (f) =>
  f.endsWith('.tsx') ? 'tsx' : f.endsWith('.jsx') ? 'jsx' : f.endsWith('.ts') ? 'ts' : 'js';

const parseError = (src, f) => {
  try {
    esb.transformSync(src, { loader: loaderOf(f), logLevel: 'silent' });
    return null;
  } catch (e) {
    const x = e.errors && e.errors[0];
    return x ? 'line ' + (x.location ? x.location.line : '?') + ': ' + x.text : String(e.message).slice(0, 120);
  }
};

const resolveSpec = (spec, from) => {
  const s = spec.split('?')[0];
  const base = s.startsWith('@/') ? path.join('src', s.slice(2)) : path.resolve(path.dirname(from), s);
  for (const e of EXTS) {
    const p = path.relative('.', base + e);
    if (isFile(p)) return { ok: p };
  }
  return { miss: path.relative('.', base) };
};

const PATTERNS = [
  /^[ \t]*(?:import|export)\s[^;'"]*?\sfrom\s*['"]([^'"]+)['"]/gm,
  /^[ \t]*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const builtin = new Set(require('module').builtinModules);
const pkgName = (s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);

const html = fs.existsSync('index.html') ? fs.readFileSync('index.html', 'utf8') : '';
const m = html.match(/src="\/?([^"]+\.tsx?)"/);
const queue = [m ? m[1] : 'src/main.tsx'];
const seen = new Set();
const broken = [];
const missing = new Map();
const pkgs = new Map();

while (queue.length) {
  const f = queue.shift();
  if (seen.has(f)) continue;
  seen.add(f);
  if (!/\.(tsx?|jsx?|mjs)$/.test(f)) continue;

  const raw = fs.readFileSync(f, 'utf8');
  if (/^(<<<<<<<|>>>>>>>)/m.test(raw)) broken.push([f, 'CONFLICT']);
  const err = parseError(raw, f);
  if (err) broken.push([f, err]);

  const specs = new Set();
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let x;
    while ((x = re.exec(raw))) specs.add(x[1]);
  }

  for (const s of specs) {
    if (s.startsWith('.') || s.startsWith('@/')) {
      const r = resolveSpec(s, f);
      if (r.ok) {
        queue.push(r.ok);
      } else {
        if (!missing.has(r.miss)) missing.set(r.miss, new Set());
        missing.get(r.miss).add(f);
      }
    } else if (!/^(node:|https?:|virtual:|~|data:)/.test(s) && !builtin.has(s)) {
      const n = pkgName(s);
      if (!fs.existsSync('node_modules/' + n)) {
        if (!pkgs.has(n)) pkgs.set(n, new Set());
        pkgs.get(n).add(f);
      }
    }
  }
}

const out = [];
out.push('######## REPORT ########', 'files checked: ' + seen.size, '');

out.push('===== A) BROKEN FILES (' + broken.length + ') =====');
for (const [f, e] of broken) {
  out.push('X ' + f + '  | ' + e);
  const hashes = sh('git log --format=%h -n 40 -- "' + f + '"').split('\n').filter(Boolean);
  let good = 'NONE';
  for (const h of hashes) {
    const s = sh('git show ' + h + ':"' + f + '"');
    if (s && !parseError(s, f)) { good = h; break; }
  }
  out.push('     last good commit: ' + good);
}

out.push('', '===== B) MISSING FILES (' + missing.size + ') =====');
for (const [p, by] of [...missing].sort()) {
  const a = [...by];
  const h = sh('git log --all --format=%h -1 -- "' + p + '.ts" "' + p + '.tsx" "' + p + '/index.ts" "' + p + '/index.tsx" "' + p + '"');
  out.push('X ' + p + '  (needed by: ' + a[0] + (a.length > 1 ? ' +' + (a.length - 1) + ' more' : '') + ')');
  out.push('     git: ' + (h ? 'was committed before (' + h + ')' : 'never committed'));
}

out.push('', '===== C) MISSING PACKAGES (' + pkgs.size + ') =====');
for (const [p, by] of pkgs) out.push('X ' + p + '  <- ' + [...by][0]);

out.push('', '===== SUMMARY =====', 'broken: ' + broken.length + ' | missing: ' + missing.size + ' | packages: ' + pkgs.size);

const report = out.join('\n');
fs.writeFileSync('check-report.txt', report);
console.log(report);
