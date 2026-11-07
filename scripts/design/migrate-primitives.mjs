#!/usr/bin/env node
// Conservative codemod for design-system Rule 2 (Card) and Rule 3 (primary Button).
//   node scripts/design/migrate-primitives.mjs                       # dry run
//   node scripts/design/migrate-primitives.mjs --write --limit=40    # apply a batch
//   node scripts/design/migrate-primitives.mjs --rule=card|button
//   node scripts/design/migrate-primitives.mjs --queue               # manual-migration queue

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const QUEUE = args.includes('--queue');
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) ?? '--limit=40').split('=')[1]);
const ONLY = (args.find((a) => a.startsWith('--rule=')) ?? '').split('=')[1];

const CARD_RE = /rounded-2xl border border-border bg-bg-secondary p-[68] shadow-card/;
const BTN_RE = /rounded-xl bg-(cta|accent) px-\d/;

/** @type {{file:string,line:number,rule:string,reason:string}[]} */
const queue = [];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'ui') continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (extname(f) === '.tsx' && !/\.(test|spec)\.tsx$/.test(f)) out.push(f);
  }
  return out;
}

function tagEnd(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (depth === 0 && (c === '"' || c === "'")) quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth > 0 && (c === '"' || c === "'" || c === '`')) quote = c;
    else if (c === '>' && depth === 0) return i + 1;
  }
  return -1;
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

function matchingClose(text, tag, from) {
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].startsWith('</')) {
      depth--;
      if (depth === 0) return m.index;
    } else {
      const end = tagEnd(text, m.index);
      if (end > 0 && text[end - 2] !== '/') depth++;
      re.lastIndex = Math.max(re.lastIndex, m.index + 1);
    }
  }
  return -1;
}

function addImport(text, name, from) {
  const already = new RegExp(`import[^;]*\\b${name}\\b[^;]*from\\s+['"]${from.replace(/[/]/g, '\\/')}['"]`).test(text);
  if (already) return text;
  const imports = [...text.matchAll(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm)];
  const stmt = `import { ${name} } from '${from}';`;
  if (!imports.length) return `${stmt}\n${text}`;
  const last = imports[imports.length - 1];
  const at = last.index + last[0].length;
  return `${text.slice(0, at)}\n${stmt}${text.slice(at)}`;
}

function conflictingIdentifier(text, name, from) {
  const decl = new RegExp(`\\b(?:const|function|class|let)\\s+${name}\\b`).test(text);
  const imp = [...text.matchAll(new RegExp(`import[^;]*\\b${name}\\b[^;]*from\\s+['"]([^'"]+)['"]`, 'g'))].some((m) => m[1] !== from);
  return decl || imp;
}

const CLASS_ATTR = /\sclassName=(?:"([^"]*)"|'([^']*)')/;

function migrateCards(rel, text) {
  if (conflictingIdentifier(text, 'Card', '@/components/ui/Card')) {
    if (CARD_RE.test(text)) queue.push({ file: rel, line: 0, rule: 'card', reason: 'file already defines/imports another `Card`' });
    return { text, n: 0 };
  }
  let n = 0;
  let out = text;
  let search = 0;
  for (;;) {
    const m = /<(div|section|motion\.div|main|a|Link)\b/g;
    m.lastIndex = search;
    const hit = m.exec(out);
    if (!hit) break;
    search = hit.index + 1;
    const end = tagEnd(out, hit.index);
    if (end < 0) continue;
    const open = out.slice(hit.index, end);
    const cls = CLASS_ATTR.exec(open);
    if (!cls || !CARD_RE.test(cls[1] ?? cls[2] ?? '')) {
      if (!cls && /className=\{/.test(open) && CARD_RE.test(open)) queue.push({ file: rel, line: lineOf(out, hit.index), rule: 'card', reason: 'dynamic className' });
      continue;
    }
    const line = lineOf(out, hit.index);
    if (hit[1] !== 'div') {
      queue.push({ file: rel, line, rule: 'card', reason: `host element <${hit[1]}> (Card renders a div)` });
      continue;
    }
    if (/\s(onClick|onKeyDown|role|tabIndex|ref)=/.test(open) || /\{\.\.\./.test(open)) {
      queue.push({ file: rel, line, rule: 'card', reason: 'interactive/ref/spread props (Card would add role/tabIndex)' });
      continue;
    }
    if (open.endsWith('/>')) continue;
    const close = matchingClose(out, 'div', end);
    if (close < 0) {
      queue.push({ file: rel, line, rule: 'card', reason: 'no matching </div> found' });
      continue;
    }
    const pad = /p-([68])\b/.exec(cls[1] ?? cls[2])[1] === '6' ? 'md' : 'lg';
    const rest = (cls[1] ?? cls[2])
      .split(/\s+/)
      .filter((t) => !['rounded-2xl', 'border', 'border-border', 'bg-bg-secondary', 'p-6', 'p-8', 'shadow-card', 'dark:shadow-card-dark'].includes(t))
      .join(' ');
    const attrs = open.slice('<div'.length, -1).replace(CLASS_ATTR, '').trimEnd();
    const props = `${pad === 'md' ? ' padding="md"' : ''} interactive={false}${rest ? ` className="${rest}"` : ''}`;
    const newOpen = `<Card${props}${attrs ? ` ${attrs.trimStart()}` : ''}>`;
    out = `${out.slice(0, hit.index)}${newOpen}${out.slice(end, close)}</Card>${out.slice(close + '</div>'.length)}`;
    search = hit.index + newOpen.length;
    n++;
  }
  if (n) out = addImport(out, 'Card', '@/components/ui/Card');
  return { text: out, n };
}

const DROP = [
  /^rounded-xl$/, /^bg-(accent|cta)$/, /^text-white$/, /^focus-ring$/, /^px-[\d.]+$/, /^py-[\d.]+$/, /^text-(xs|sm|base)$/,
  /^font-(medium|semibold)$/, /^hover:(brightness-110|bg-accent\/90|opacity-90)$/, /^transition-(all|colors|opacity)$/,
  /^disabled:[\w:/-]+$/, /^(inline-)?flex$/, /^items-center$/, /^justify-center$/, /^gap-[\d.]+$/,
];
const VISUAL_CONFLICT = /^(rounded|border|bg-|text-|shadow|hover:|dark:|ring|min-h|h-|leading|font-|uppercase|whitespace)/;

function migrateButtons(rel, text) {
  if (conflictingIdentifier(text, 'Button', '@/components/ui/Button')) {
    if (BTN_RE.test(text)) queue.push({ file: rel, line: 0, rule: 'button', reason: 'file already defines/imports another `Button`' });
    return { text, n: 0 };
  }
  let n = 0;
  let out = text;
  let search = 0;
  for (;;) {
    const m = /<(button|a|Link|label|motion\.button)\b/g;
    m.lastIndex = search;
    const hit = m.exec(out);
    if (!hit) break;
    search = hit.index + 1;
    const end = tagEnd(out, hit.index);
    if (end < 0) continue;
    const open = out.slice(hit.index, end);
    if (!BTN_RE.test(open)) continue;
    const line = lineOf(out, hit.index);
    if (hit[1] !== 'button') {
      queue.push({ file: rel, line, rule: 'button', reason: `host element <${hit[1]}> (Button renders a <button>)` });
      continue;
    }
    const cls = CLASS_ATTR.exec(open);
    if (!cls) {
      queue.push({ file: rel, line, rule: 'button', reason: 'dynamic className' });
      continue;
    }
    if (/\s(ref|size|variant|loading|tone|fullWidth)=/.test(open) || /\{\.\.\./.test(open)) {
      queue.push({ file: rel, line, rule: 'button', reason: 'conflicting props / spread' });
      continue;
    }
    const tokens = (cls[1] ?? cls[2]).split(/\s+/).filter(Boolean);
    const keep = tokens.filter((t) => !DROP.some((r) => r.test(t)));
    const conflict = keep.find((t) => t !== 'w-full' && VISUAL_CONFLICT.test(t));
    if (conflict) {
      queue.push({ file: rel, line, rule: 'button', reason: `extra visual token \`${conflict}\`` });
      continue;
    }
    const close = out.indexOf('</button>', end);
    if (close < 0 || open.endsWith('/>')) continue;
    if (/<button\b/.test(out.slice(end, close))) {
      queue.push({ file: rel, line, rule: 'button', reason: 'nested <button>' });
      continue;
    }
    const xs = tokens.includes('text-xs');
    const md = tokens.some((t) => /^py-(3|3\.5|4)$/.test(t)) || tokens.includes('text-base');
    const size = xs ? 'xs' : md ? 'md' : 'sm';
    const fullWidth = keep.includes('w-full');
    const rest = keep.filter((t) => t !== 'w-full').join(' ');
    const cta = tokens.includes('bg-cta');
    const attrs = open.slice('<button'.length, -1).replace(CLASS_ATTR, '').trimEnd();
    const props = `${size === 'sm' ? '' : ` size="${size}"`}${cta ? ' tone="cta"' : ''}${fullWidth ? ' fullWidth' : ''}${rest ? ` className="${rest}"` : ''}`;
    const newOpen = `<Button${props}${attrs ? ` ${attrs.trimStart()}` : ''}>`;
    out = `${out.slice(0, hit.index)}${newOpen}${out.slice(end, close)}</Button>${out.slice(close + '</button>'.length)}`;
    search = hit.index + newOpen.length;
    n++;
  }
  if (n) out = addImport(out, 'Button', '@/components/ui/Button');
  return { text: out, n };
}

const report = [];
let written = 0;
for (const file of walk(join(ROOT, 'src'))) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, 'utf8');
  if (!CARD_RE.test(src) && !BTN_RE.test(src)) continue;
  let text = src;
  let cards = 0;
  let buttons = 0;
  if (ONLY !== 'button') ({ text, n: cards } = migrateCards(rel, text));
  if (ONLY !== 'card') ({ text, n: buttons } = migrateButtons(rel, text));
  if (!cards && !buttons) continue;
  if (WRITE && written >= LIMIT) break;
  report.push({ rel, cards, buttons });
  if (WRITE) {
    writeFileSync(file, text);
    written++;
  }
}

if (QUEUE) for (const q of queue) console.log(`${q.file}:${q.line}\t[${q.rule}]\t${q.reason}`);
const sum = (k) => report.reduce((a, r) => a + r[k], 0);
console.log(`${WRITE ? 'WROTE' : 'DRY RUN'}: ${report.length} files, ${sum('cards')} <Card>, ${sum('buttons')} <Button>, ${queue.length} queued for manual migration`);
if (!WRITE) console.log('Re-run with --write --limit=40 to apply a batch.');
