// scripts/lib/knowledgeChunker.mjs
//
// Pure helpers for scripts/knowledge-build.mjs. No network, no esbuild,
// no Supabase — everything here is deterministic and unit-tested
// (scripts/lib/knowledgeChunker.test.mjs, run with `node --test`).

import { createHash } from 'node:crypto';

/** ~4 chars/token is the usual English heuristic; good enough for sizing. */
export const estimateTokens = (text) => Math.ceil(text.length / 4);

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export const slugify = (text) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';

export const TARGET_MAX_TOKENS = 500;
export const OVERLAP_TOKENS = 40;

/**
 * Splits long text into chunks of <= maxTokens, on paragraph then sentence
 * boundaries, with a small overlap so a fact straddling a boundary survives.
 * Text already <= maxTokens is returned as ONE chunk (atomic facts such as a
 * single FAQ answer or one plan are never fragmented).
 */
export function splitIntoChunks(text, maxTokens = TARGET_MAX_TOKENS, overlapTokens = OVERLAP_TOKENS) {
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];
  if (estimateTokens(clean) <= maxTokens) return [clean];

  const maxChars = maxTokens * 4;
  const overlapChars = overlapTokens * 4;

  // Break into sentence-ish units, keeping paragraph breaks.
  const units = clean
    .split(/\n{2,}/)
    .flatMap((para) => para.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n|$)/g) ?? [para])
    .map((u) => u.trim())
    .filter(Boolean)
    // a run-on unit is hard-wrapped so that overlap + unit always fits in one chunk
    .flatMap((u) => hardWrap(u, maxChars - overlapChars));

  const chunks = [];
  let current = '';
  for (const unit of units) {
    if (current && (current + ' ' + unit).length > maxChars) {
      chunks.push(current.trim());
      const tail = current.slice(-overlapChars);
      const cut = tail.indexOf(' ');
      current = (cut > -1 ? tail.slice(cut + 1) : tail) + ' ' + unit;
    } else {
      current = current ? current + ' ' + unit : unit;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function hardWrap(unit, maxChars) {
  if (unit.length <= maxChars) return [unit];
  const out = [];
  let rest = unit;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Builds chunk records from one logical document. Titles are repeated on
 * every part ("Title (2/3)") so each chunk is self-describing when retrieved
 * alone.
 */
export function buildChunks({ source, slug, topic, title, url, plans = [], status = 'live', text }) {
  const parts = splitIntoChunks(text);
  return parts.map((content, i) => ({
    chunkKey: `${source}:${slug}:${i + 1}`,
    topic,
    title: parts.length > 1 ? `${title} (${i + 1}/${parts.length})` : title,
    content,
    url: url ?? null,
    plans,
    status,
    lang: 'en',
    tokenEstimate: estimateTokens(content),
  }));
}

/**
 * Extracts the `CATEGORIES` literal from src/pages/FeaturesPage.tsx WITHOUT
 * importing the page (which would drag in React/router/UI). Icons are
 * identifiers, so they're stripped before evaluating the plain data literal.
 * Throws loudly if the shape changes, so CI never silently loses coverage.
 */
export function extractFeatureCatalog(tsxSource) {
  const marker = /const\s+CATEGORIES\s*:\s*Category\[\]\s*=\s*\[/;
  const m = marker.exec(tsxSource);
  if (!m) throw new Error('FeaturesPage.tsx: `const CATEGORIES: Category[] = [` not found — update extractFeatureCatalog().');

  const start = m.index + m[0].length - 1; // index of the opening "["
  let depth = 0;
  let inStr = null;
  let end = -1;
  for (let i = start; i < tsxSource.length; i++) {
    const ch = tsxSource[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') inStr = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error('FeaturesPage.tsx: could not find end of CATEGORIES literal.');

  const literal = tsxSource
    .slice(start, end + 1)
    .replace(/\bicon\s*:\s*[A-Za-z_][A-Za-z0-9_]*\s*,?/g, '');
  // eslint-disable-next-line no-new-func
  const data = new Function(`"use strict"; return (${literal});`)();
  if (!Array.isArray(data) || !data.every((c) => c && typeof c.label === 'string' && Array.isArray(c.features))) {
    throw new Error('FeaturesPage.tsx: CATEGORIES shape changed (expected [{label, tagline, features:[{title, body, href?}]}]).');
  }
  return data;
}

/**
 * Minimal front-matter parser for knowledge/modules/*.md:
 *   ---
 *   title: ...
 *   url: /path
 *   topic: module
 *   plans: professional, business
 *   status: live | beta | planned
 *   verified: 2028-03-01
 *   ---
 *   body...
 */
export function parseMarkdownDoc(raw, fileName) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw.replace(/\r\n/g, '\n'));
  if (!m) throw new Error(`${fileName}: missing front-matter block.`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  for (const req of ['title', 'url', 'topic', 'status', 'verified']) {
    if (!meta[req]) throw new Error(`${fileName}: front-matter field "${req}" is required.`);
  }
  if (!['live', 'beta', 'planned'].includes(meta.status)) {
    throw new Error(`${fileName}: status must be live | beta | planned (got "${meta.status}").`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.verified)) {
    throw new Error(`${fileName}: verified must be YYYY-MM-DD.`);
  }
  if (!meta.url.startsWith('/')) throw new Error(`${fileName}: url must be a site-relative path starting with "/".`);
  const plans = meta.plans ? meta.plans.split(',').map((p) => p.trim()).filter(Boolean) : [];
  return { meta: { ...meta, plans }, body: m[2].trim() };
}

/** Public, static routes declared in App.tsx (no params, no private areas). */
export function extractPublicRoutes(appTsx) {
  const PRIVATE = /^\/(dashboard|staff|tech|admin|portal|home|login|mfa|sso-login|forgot-password|reset-password|onboarding|error|offline|maintenance|thank-you|pay-result|status\/unsubscribe|talent\/me|emergency)(\/|$)/;
  const set = new Set();
  for (const m of appTsx.matchAll(/path="([^"]+)"/g)) {
    const p = m[1];
    if (p === '*' || !p.startsWith('/') || p.includes(':') || p.includes('*')) continue;
    if (PRIVATE.test(p)) continue;
    set.add(p);
  }
  return [...set].sort();
}

/** Normalises an absolute/relative URL to a comparable path. */
export function toPath(url) {
  if (!url) return null;
  try {
    return new URL(url, 'https://vireek.com').pathname.replace(/\/$/, '') || '/';
  } catch {
    return null;
  }
}

const ENTITIES = { '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”', '&amp;': '&', '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&middot;': '·', '&apos;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>', '&hellip;': '…', '&copy;': '©', '&bull;': '•' };
const BLOCK_TAGS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'tr', 'td', 'th', 'dt', 'dd', 'blockquote', 'ul', 'ol', 'table', 'details', 'summary', 'br']);

const decodeEntities = (t) =>
  t.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&[a-z]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ');

/**
 * Extracts human-readable prose from a static JSX/TSX component using the
 * real TypeScript parser (pass the `typescript` module in as `ts`).
 *
 * Captured: JSX text, {'string literal'} children, {CONST} children whose
 * value is a plain string const in the same file, and `title="..."` on custom
 * components (headings such as <SectionHeading title="Cancellation" />).
 * NOT captured: copy that lives in JS arrays/objects and is rendered through
 * a loop — callers should report the extracted length so gaps are visible.
 */
export function extractJsxText(source, ts, fileName = 'component.tsx') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const consts = new Map();
  (function collect(n) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
        (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer))) {
      consts.set(n.name.text, n.initializer.text);
    }
    ts.forEachChild(n, collect);
  })(sf);

  const out = [];
  const tagOf = (el) => el.tagName.getText(sf);

  function visit(n) {
    if (ts.isJsxText(n)) {
      const raw = decodeEntities(n.text);
      if (!raw.trim()) return; // whitespace-only between elements is insignificant in JSX
      out.push(raw.replace(/\s+/g, ' '));
      return;
    }
    if (ts.isJsxAttribute(n)) return;
    if (ts.isJsxExpression(n) && n.expression) {
      const e = n.expression;
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) out.push(decodeEntities(e.text));
      else if (ts.isIdentifier(e) && consts.has(e.text)) out.push(consts.get(e.text));
      else ts.forEachChild(e, visit); // JSX inside .map()/conditionals
      return;
    }
    const opening = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
    if (opening) {
      const tag = tagOf(opening);
      const block = BLOCK_TAGS.has(tag.toLowerCase());
      if (/^[A-Z]/.test(tag)) {
        for (const a of opening.attributes.properties) {
          if (ts.isJsxAttribute(a) && a.name.getText(sf) === 'title' && a.initializer && ts.isStringLiteral(a.initializer)) {
            out.push('\n' + a.initializer.text + '\n');
          }
        }
      }
      if (block) out.push('\n');
      ts.forEachChild(n, visit);
      if (block) out.push('\n');
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);

  return out
    .join('')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\s+([.,;:!?])/g, '$1');
}
