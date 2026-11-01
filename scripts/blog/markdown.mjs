// scripts/blog/markdown.mjs
//
// Dependency-free parser for the Vireek blog's Markdown dialect. It produces a small, serialisable
// AST (no HTML strings, no raw HTML support) so rendering is XSS-safe by construction: React
// escapes every text node, and links are allow-listed by scheme.
//
// Supported syntax is documented in content/blog/README.md.

export const DIRECTIVES = new Set(['tip', 'warning', 'stat', 'takeaways', 'steps', 'cta', 'calculator', 'figure']);
export const CTA_TYPES = ['trial', 'demo', 'pricing', 'calculator'];

const SAFE_HREF = /^(?:\/(?!\/)|#|https:\/\/|http:\/\/|mailto:)/;
const TABLE_DELIM = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const DIRECTIVE_OPEN = /^:::([a-z]+)(?:\s+(.*))?$/;

export function slugifyHeading(text) {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

/* ----------------------------- inline ----------------------------- */

function findLinkClose(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

export function parseInline(src, ctx) {
  const out = [];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const j = src.indexOf('`', i + 1);
      if (j > i + 1) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    }
    if (ch === '*' && src[i + 1] === '*') {
      const j = src.indexOf('**', i + 2);
      if (j > i + 2) {
        flush();
        out.push({ t: 'strong', c: parseInline(src.slice(i + 2, j), ctx) });
        i = j + 2;
        continue;
      }
    }
    if (ch === '*' && src[i + 1] !== '*' && src[i + 1] !== ' ') {
      let j = i + 1;
      while (j < src.length && !(src[j] === '*' && src[j + 1] !== '*' && src[j - 1] !== ' ')) j++;
      if (j < src.length && j > i + 1) {
        flush();
        out.push({ t: 'em', c: parseInline(src.slice(i + 1, j), ctx) });
        i = j + 1;
        continue;
      }
    }
    if (ch === '[') {
      const close = findLinkClose(src, i);
      if (close > i && src[close + 1] === '(') {
        const end = src.indexOf(')', close + 2);
        if (end > close) {
          const href = src.slice(close + 2, end).trim();
          const label = src.slice(i + 1, close);
          if (SAFE_HREF.test(href) && label.trim()) {
            flush();
            ctx.links.push(href);
            out.push({ t: 'link', href, c: parseInline(label, ctx) });
          } else {
            ctx.errors.push(`unsafe or empty link: [${label}](${href})`);
            buf += label;
          }
          i = end + 1;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

export function inlineToText(nodes) {
  return nodes
    .map((n) => (n.t === 'text' || n.t === 'code' ? n.v : inlineToText(n.c)))
    .join('');
}

/* ----------------------------- blocks ----------------------------- */

export function parseAttrs(str = '') {
  const attrs = {};
  const re = /([a-zA-Z]+)=(?:"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(str))) attrs[m[1]] = m[2] ?? m[3];
  return attrs;
}

function splitRow(line) {
  const cells = [];
  let cur = '';
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const isBlockStart = (line, next) =>
  /^#{1,6}\s/.test(line) ||
  /^[-*]\s+/.test(line) ||
  /^\d+[.)]\s+/.test(line) ||
  /^>\s?/.test(line) ||
  DIRECTIVE_OPEN.test(line) ||
  (line.trim().startsWith('|') && next !== undefined && TABLE_DELIM.test(next));

function parseList(lines, start, ordered, ctx) {
  const marker = ordered ? /^\d+[.)]\s+(.*)$/ : /^[-*]\s+(.*)$/;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(marker);
    if (!m) break;
    let text = m[1];
    i++;
    while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !marker.test(lines[i].trim())) {
      text += ' ' + lines[i].trim();
      i++;
    }
    items.push(parseInline(text, ctx));
  }
  return { items, next: i };
}

/**
 * @param {string[]} lines
 * @param {{errors:string[], links:string[], ids:Map<string,number>, seenH2:boolean, depth:number}} ctx
 */
export function parseBlocks(lines, ctx) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const dir = line.match(DIRECTIVE_OPEN);
    if (dir) {
      const [, name, attrStr] = dir;
      if (!DIRECTIVES.has(name)) {
        ctx.errors.push(`unknown directive ":::${name}"`);
        i++;
        continue;
      }
      let depth = 1;
      let j = i + 1;
      const body = [];
      while (j < lines.length) {
        if (DIRECTIVE_OPEN.test(lines[j])) depth++;
        else if (lines[j].trim() === ':::' && --depth === 0) break;
        body.push(lines[j]);
        j++;
      }
      if (depth !== 0) {
        ctx.errors.push(`unclosed directive ":::${name}"`);
        break;
      }
      const block = buildDirective(name, parseAttrs(attrStr), body, ctx);
      if (block) blocks.push(block);
      i = j + 1;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length;
      const inline = parseInline(h[2], ctx);
      const text = inlineToText(inline);
      if (level === 1) ctx.errors.push(`"# ${text}": h1 is reserved for the page title — use ## or ###`);
      else if (level > 3) ctx.errors.push(`"${h[1]} ${text}": only h2 and h3 are supported`);
      else {
        if (level === 3 && !ctx.seenH2) ctx.errors.push(`"### ${text}": h3 appears before any h2 (heading order)`);
        if (level === 2) ctx.seenH2 = true;
        const base = slugifyHeading(text);
        const n = ctx.ids.get(base) ?? 0;
        ctx.ids.set(base, n + 1);
        blocks.push({ t: level === 2 ? 'h2' : 'h3', id: n ? `${base}-${n + 1}` : base, c: inline });
      }
      i++;
      continue;
    }

    if (line.trim().startsWith('|') && lines[i + 1] !== undefined && TABLE_DELIM.test(lines[i + 1])) {
      const head = splitRow(line).map((c) => parseInline(c, ctx));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = splitRow(lines[i]);
        if (cells.length !== head.length) {
          ctx.errors.push(`table row has ${cells.length} cells, header has ${head.length}: "${lines[i].trim().slice(0, 60)}"`);
        }
        rows.push(cells.map((c) => parseInline(c, ctx)));
        i++;
      }
      blocks.push({ t: 'table', head, rows });
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const { items, next } = parseList(lines, i, false, ctx);
      blocks.push({ t: 'ul', items });
      i = next;
      continue;
    }
    if (/^\d+[.)]\s+/.test(line)) {
      const { items, next } = parseList(lines, i, true, ctx);
      blocks.push({ t: 'ol', items });
      i = next;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', c: parseInline(buf.join(' '), ctx) });
      continue;
    }

    const buf = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) buf.push(lines[i++].trim());
    blocks.push({ t: 'p', c: parseInline(buf.join(' '), ctx) });
  }
  return blocks;
}

function buildDirective(name, attrs, bodyLines, ctx) {
  if (ctx.depth >= 2) {
    ctx.errors.push(`directive ":::${name}" is nested too deeply`);
    return null;
  }
  const inner = { ...ctx, depth: ctx.depth + 1 };
  const children = () => parseBlocks(bodyLines, inner);

  if (name === 'tip' || name === 'warning' || name === 'stat') {
    const c = children();
    if (!c.length) ctx.errors.push(`":::${name}" is empty`);
    return { t: 'callout', kind: name, c };
  }
  if (name === 'takeaways' || name === 'steps') {
    const c = children();
    const list = c.find((b) => b.t === (name === 'steps' ? 'ol' : 'ul'));
    if (!list || c.length !== 1) {
      ctx.errors.push(`":::${name}" must contain exactly one ${name === 'steps' ? 'numbered' : 'bulleted'} list`);
      return null;
    }
    return { t: name, items: list.items };
  }
  if (name === 'cta') {
    const type = attrs.type ?? 'trial';
    if (!CTA_TYPES.includes(type)) {
      ctx.errors.push(`":::cta type=${type}" must be one of ${CTA_TYPES.join(', ')}`);
      return null;
    }
    const c = children();
    const first = c[0]?.t === 'p' ? c[0].c : [];
    return { t: 'cta', type, heading: attrs.heading ?? '', button: attrs.button ?? '', body: first };
  }
  if (name === 'calculator') return { t: 'calculator' };
  if (name === 'figure') {
    const width = Number(attrs.width);
    const height = Number(attrs.height);
    if (!attrs.src || !/^(\/|https:\/\/)/.test(attrs.src)) ctx.errors.push('":::figure" needs src (starting with / or https://)');
    if (!attrs.alt || attrs.alt.trim().length < 5) ctx.errors.push('":::figure" needs descriptive alt text (≥5 chars)');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      ctx.errors.push('":::figure" needs integer width and height (prevents layout shift)');
    }
    return { t: 'figure', src: attrs.src ?? '', alt: attrs.alt ?? '', width, height, caption: parseInline(bodyLines.join(' ').trim(), ctx) };
  }
  return null;
}

/* ----------------------------- document ----------------------------- */

export function blocksToText(blocks) {
  const parts = [];
  const walk = (bs) => {
    for (const b of bs) {
      if (b.c && b.t !== 'callout') parts.push(inlineToText(b.c));
      if (b.items) b.items.forEach((it) => parts.push(inlineToText(it)));
      if (b.t === 'table') [b.head, ...b.rows].forEach((r) => r.forEach((c) => parts.push(inlineToText(c))));
      if (b.t === 'callout') walk(b.c);
      if (b.t === 'cta') parts.push(b.heading, inlineToText(b.body));
      if (b.t === 'figure') parts.push(inlineToText(b.caption));
    }
  };
  walk(blocks);
  return parts.join(' ');
}

export const countWords = (text) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

export function readTimeMinutes(words) {
  return Math.max(1, Math.ceil(words / 220));
}

/** @returns {{ blocks: any[], toc: {id:string,text:string,level:2|3}[], links: string[], errors: string[] }} */
export function parseMarkdown(source) {
  const ctx = { errors: [], links: [], ids: new Map(), seenH2: false, depth: 0 };
  const blocks = parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'), ctx);
  const toc = [];
  const walk = (bs) => {
    for (const b of bs) {
      if (b.t === 'h2' || b.t === 'h3') toc.push({ id: b.id, text: inlineToText(b.c), level: b.t === 'h2' ? 2 : 3 });
      if (b.t === 'callout') walk(b.c);
    }
  };
  walk(blocks);
  return { blocks, toc, links: ctx.links, errors: ctx.errors };
}
