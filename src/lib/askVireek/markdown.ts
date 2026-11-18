// src/lib/askVireek/markdown.ts
//
// Minimal, dependency-free, XSS-safe markdown subset for assistant replies:
// paragraphs, "-" / "*" / "1." lists, fenced + inline code, **bold**, *italic*,
// and links. The output is a plain data tree (no HTML strings) that the React
// renderer turns into elements, so model output can never inject markup.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'bold'; v: Inline[] }
  | { t: 'em'; v: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; external: boolean; v: Inline[] };

export type Block =
  | { t: 'p'; v: Inline[] }
  | { t: 'ul'; v: Inline[][] }
  | { t: 'ol'; v: Inline[][] }
  | { t: 'code'; lang: string; v: string };

const SITE_HOSTS = new Set(['vireek.com', 'www.vireek.com']);

export interface SafeHref {
  href: string;
  external: boolean;
}

/**
 * Only site-relative paths, https://(www.)vireek.com URLs and mailto: links are
 * allowed. Everything else (javascript:, data:, other hosts, protocol-relative)
 * returns null and is rendered as plain text — a poisoned model reply or
 * retrieved chunk can never make the widget link off-site.
 */
export function safeHref(raw: string): SafeHref | null {
  const url = raw.trim();
  if (!url || /[\u0000-\u001f\s]/.test(url)) return null;
  if (url.startsWith('/') && !url.startsWith('//') && !url.includes('\\')) return { href: url, external: false };
  if (/^mailto:[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/i.test(url)) return { href: url, external: true };
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && SITE_HOSTS.has(u.hostname) && !u.username && !u.password) {
      return { href: `${u.pathname}${u.search}${u.hash}` || '/', external: false };
    }
  } catch {
    /* not a URL */
  }
  return null;
}

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\*[^*\s][^*\n]*?\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>)]+)/g;

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of src.matchAll(INLINE_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ t: 'text', v: src.slice(last, i) });
    const tok = m[0];
    if (m[1]) out.push({ t: 'code', v: tok.slice(1, -1) });
    else if (m[2] && depth < 2) out.push({ t: 'bold', v: parseInline(tok.slice(2, -2), depth + 1) });
    else if (m[3] && depth < 2) out.push({ t: 'em', v: parseInline(tok.slice(1, -1), depth + 1) });
    else if (m[4]) {
      const close = tok.indexOf('](');
      const label = tok.slice(1, close);
      const safe = safeHref(tok.slice(close + 2, -1));
      if (safe) out.push({ t: 'link', ...safe, v: [{ t: 'text', v: label }] });
      else out.push({ t: 'text', v: label });
    } else if (m[5]) {
      const trimmed = tok.replace(/[.,;:!?]+$/, '');
      const safe = safeHref(trimmed);
      if (safe) out.push({ t: 'link', ...safe, v: [{ t: 'text', v: trimmed }] });
      else out.push({ t: 'text', v: trimmed });
      if (trimmed.length < tok.length) out.push({ t: 'text', v: tok.slice(trimmed.length) });
    } else out.push({ t: 'text', v: tok });
    last = i + tok.length;
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) });
  return out;
}

const UL_RE = /^\s{0,3}[-*•]\s+(.*)$/;
const OL_RE = /^\s{0,3}\d{1,2}[.)]\s+(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', v: parseInline(para.join('\n').trim()) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s{0,3}```\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      // An unterminated fence (stream still in flight) renders what arrived so far.
      while (i < lines.length && !/^\s{0,3}```\s*$/.test(lines[i])) body.push(lines[i++]);
      blocks.push({ t: 'code', lang: fence[1] ?? '', v: body.join('\n') });
      continue;
    }
    const ul = UL_RE.exec(line);
    const ol = ul ? null : OL_RE.exec(line);
    if (ul || ol) {
      flush();
      const ordered = !!ol;
      const items: Inline[][] = [];
      let j = i;
      while (j < lines.length) {
        const m = (ordered ? OL_RE : UL_RE).exec(lines[j]);
        if (!m) break;
        items.push(parseInline(m[1].trim()));
        j++;
      }
      blocks.push({ t: ordered ? 'ol' : 'ul', v: items });
      i = j - 1;
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line.replace(/^#{1,6}\s+/, ''));
  }
  flush();
  return blocks;
}
