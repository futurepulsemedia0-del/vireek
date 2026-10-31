#!/usr/bin/env node
// scripts/codemod-loading.mjs — migrates ad-hoc spinners/pulses to Vireek Pulse.
//   node scripts/codemod-loading.mjs            → dry run (prints stats)
//   node scripts/codemod-loading.mjs --write    → applies changes + writes MIGRATION_REPORT.md
// Only SAFE, mechanical patterns are rewritten; everything else is listed in the report.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const WRITE = process.argv.includes('--write');
const SKIP = [/[\\/]components[\\/]loading[\\/]/, /[\\/]pages[\\/]dev[\\/]/, /\.test\.tsx?$/, /\.stories\./];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') && !SKIP.some((r) => r.test(p))) out.push(p);
  }
  return out;
}

const stats = { loader2: 0, borderSpinner: 0, skeleton: 0, files: 0 };
const left = []; // { file, line, kind, snippet }

const hasSize = (c) => /(^|\s)(h|w|size)-\S+/.test(c);
const clean = (c) => c.replace(/\s+/g, ' ').trim();
const attr = (c) => (c ? ` className="${c}"` : '');

function spinnerTag(sizeProp, classes) {
  const c = clean(classes.replace(/(^|\s)animate-spin(?=\s|$)/g, ' '));
  const size = sizeProp ?? (hasSize(c) ? null : '24');
  return `<Spinner${size ? ` size={${size}}` : ''}${attr(c)} />`;
}

function transform(src) {
  let out = src;
  let n = 0;

  // A) <Loader2 size={N} className="… animate-spin …" aria-hidden="true" />
  out = out.replace(/<Loader2\b([^<>]*?)\/>/g, (whole, attrs) => {
    const cls = /className="([^"]*)"/.exec(attrs)?.[1];
    if (!cls || !/(^|\s)animate-spin(\s|$)/.test(cls)) return whole;
    const rest = attrs
      .replace(/className="[^"]*"/, '')
      .replace(/size=\{(\d+)\}/, '')
      .replace(/aria-hidden(="true"|=\{true\})?/, '')
      .trim();
    if (rest) return whole; // unknown props (strokeWidth, style…) → manual
    const size = /size=\{(\d+)\}/.exec(attrs)?.[1] ?? null;
    stats.loader2++;
    n++;
    return spinnerTag(size, cls);
  });

  // B) <div className="h-5 w-5 animate-spin rounded-full border-2 border-X border-t-Y" />
  out = out.replace(/<div\s+className="([^"]*animate-spin[^"]*)"\s*(?:\/>|><\/div>)/g, (whole, cls) => {
    if (!/rounded-full/.test(cls) || !/(^|\s)border/.test(cls)) return whole;
    const arc = /border-t-(\S+)/.exec(cls)?.[1];
    const side = [...cls.matchAll(/(?:^|\s)border-([a-z-]+(?:\/\d+)?)(?=\s|$)/g)]
      .map((m) => m[1])
      .find((t) => t !== 'transparent' && t !== 'border' && !/^[0-9]+$/.test(t) && !/^[trblxy]$/.test(t));
    const colour = arc && arc !== 'transparent' ? arc : side;
    const stripped = cls
      .replace(/(^|\s)(animate-spin|rounded-full|border|border-\d+|border-[trblxy]-\S+|border-\S+)(?=\s|$)/g, ' ')
      .replace(/\s+/g, ' ');
    const withColour = colour && colour !== 'border' ? `${stripped} text-${colour}` : stripped;
    stats.borderSpinner++;
    n++;
    return spinnerTag(null, withColour);
  });

  // C) animate-pulse on plain skeleton blocks → vrk-skel (shimmer, transform-only)
  out = out.replace(/className="([^"]*animate-pulse[^"]*)"/g, (whole, cls) => {
    if (!/bg-bg-tertiary|bg-border|bg-bg-secondary/.test(cls)) return whole;
    if (/(^|\s)(absolute|fixed|sticky)(\s|$)/.test(cls)) return whole;
    if (/rounded-full/.test(cls) && /(^|\s)(h|w)-(0\.5|1|1\.5|2|2\.5|3)(\s|$)/.test(cls)) return whole; // live dots
    stats.skeleton++;
    n++;
    return `className="${clean(cls.replace(/(^|\s)animate-pulse(?=\s|$)/g, ' $&').replace('animate-pulse', 'vrk-skel'))}"`;
  });

  if (!n) return null;

  // Imports
  if (/<Spinner\b/.test(out) && !/from '@\/components\/loading(\/Spinner)?'/.test(out)) {
    const lines = out.split('\n');
    let lastImportEnd = -1;
    let inImport = false;
    lines.forEach((l, i) => {
      if (!inImport && /^import\b/.test(l)) inImport = true;
      if (inImport && /;\s*$/.test(l)) {
        lastImportEnd = i;
        inImport = false;
      }
    });
    lines.splice(lastImportEnd + 1, 0, "import { Spinner } from '@/components/loading/Spinner';");
    out = lines.join('\n');
  }
  const body = out.replace(/import\s*{[^}]*}\s*from\s*'lucide-react';?/g, '');
  if (!/\bLoader2\b/.test(body)) {
    out = out.replace(/import\s*{([^}]*)}\s*from\s*'lucide-react';?\n?/, (whole, list) => {
      const names = list.split(',').map((s) => s.trim()).filter((s) => s && s !== 'Loader2' && !/\bas\s+Loader2$/.test(s));
      return names.length ? `import { ${names.join(', ')} } from 'lucide-react';\n` : '';
    });
  }
  return out;
}

const files = walk(SRC);
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const next = transform(src);
  const finalSrc = next ?? src;
  if (next) {
    stats.files++;
    if (WRITE) writeFileSync(file, next);
  }
  finalSrc.split('\n').forEach((line, i) => {
    if (/animate-spin|animate-pulse/.test(line)) {
      const kind = /RefreshCw|Rotate|Sync/.test(line) ? 'rotating icon (intentional)' : /animate-pulse/.test(line) ? 'pulse (live dot / non-skeleton)' : 'spin (non-standard markup)';
      left.push({ file: relative(ROOT, file).replace(/\\/g, '/'), line: i + 1, kind, snippet: line.trim().slice(0, 110) });
    }
  });
}

console.log(`${WRITE ? 'Applied' : 'Would apply'}: ${stats.loader2} Loader2 → <Spinner/>, ${stats.borderSpinner} border spinners → <Spinner/>, ${stats.skeleton} pulse blocks → vrk-skel, in ${stats.files} files.`);
console.log(`Left for manual review: ${left.length} lines.`);

if (WRITE) {
  const byKind = left.reduce((a, l) => ((a[l.kind] ??= []).push(l), a), {});
  let md = `# Vireek Pulse migration report\n\nConverted: ${stats.loader2} Loader2, ${stats.borderSpinner} border spinners, ${stats.skeleton} skeleton pulses (${stats.files} files).\n\nNot converted on purpose (${left.length}):\n`;
  for (const [kind, items] of Object.entries(byKind)) {
    md += `\n## ${kind} (${items.length})\n` + items.map((l) => `- \`${l.file}:${l.line}\` ${l.snippet.replace(/`/g, "'")}`).join('\n') + '\n';
  }
  writeFileSync(join(ROOT, 'MIGRATION_REPORT.md'), md);
  console.log('Wrote MIGRATION_REPORT.md');
}
