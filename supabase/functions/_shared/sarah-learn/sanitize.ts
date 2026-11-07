// supabase/functions/_shared/sarah-learn/sanitize.ts
//
// Turns untrusted HTML into bounded plain text that is safe to place inside a
// model prompt as DATA. Pure TypeScript, no Deno globals.
//
// Defence in depth against prompt injection hidden in page content:
//   1. script/style/template/svg/iframe/comment blocks are dropped
//   2. elements hidden with `hidden`, aria-hidden, display:none,
//      visibility:hidden, font-size:0 or opacity:0 are dropped (classic
//      invisible-text injection)
//   3. known injection phrases are defanged and reported (`injectionFlags`)
//   4. the result is wrapped in <untrusted_source> tags by `wrapUntrusted`,
//      with any closing tag inside the text neutralised
// The extraction step additionally never trusts model output: see schema.ts.

// The AI Core input guardrail truncates any single user message at 4000 chars, so
// each source is capped below that (tag wrapper included) and extracted per source.
export const MAX_SOURCE_CHARS = 3700;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ndash;': '-',
  '&mdash;': '-',
  '&rsquo;': "'",
  '&lsquo;': "'",
  '&rdquo;': '"',
  '&ldquo;': '"',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp|ndash|mdash|rsquo|lsquo|rdquo|ldquo);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d{1,6});/g, (_, n: string) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => {
      const code = parseInt(h, 16);
      return code > 0 && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
    });
}

// Phrases that try to steer a model. Matching is on normalised text.
const INJECTION_RULES: { id: string; re: RegExp }[] = [
  { id: 'ignore_previous', re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.\n]{0,30}\b(instruction|prompt|rule|direction|context)s?\b/gi },
  { id: 'reveal_prompt', re: /\b(reveal|show|print|repeat|leak|output)\b[^.\n]{0,30}\b(system|hidden|initial)\b[^.\n]{0,15}\b(prompt|instruction|message)s?\b/gi },
  { id: 'role_hijack', re: /\b(you are now|from now on you|act as|pretend to be|new instructions?:|developer mode)\b/gi },
  { id: 'chat_markup', re: /(<\|?(?:im_start|im_end|system|assistant|user)\|?>|\[\/?INST\]|<<\/?SYS>>|^\s*(?:system|assistant)\s*:)/gim },
  { id: 'tool_call', re: /\b(call|invoke|execute|run)\b[^.\n]{0,25}\b(function|tool|command|api)\b/gi },
  { id: 'exfiltrate', re: /\b(send|post|exfiltrate|upload|email)\b[^.\n]{0,40}\b(api[_ -]?key|password|secret|token|credential)s?\b/gi },
  { id: 'set_price', re: /\b(always|must)\b[^.\n]{0,30}\b(quote|charge|say)\b[^.\n]{0,20}\$\s?\d/gi },
];

export interface SanitizedText {
  text: string;
  injectionFlags: string[];
}

/** Defang steering phrases and report which rules fired. */
export function defangInjection(text: string): SanitizedText {
  const flags = new Set<string>();
  let out = text;
  for (const rule of INJECTION_RULES) {
    rule.re.lastIndex = 0;
    if (rule.re.test(out)) {
      flags.add(rule.id);
      rule.re.lastIndex = 0;
      out = out.replace(new RegExp(rule.re.source + '[^.!?\\n]*[.!?]?', rule.re.flags), '[removed: instruction-like text]');
    }
  }
  return { text: out, injectionFlags: [...flags] };
}

const HIDDEN_ATTR =
  /(?:\shidden(?:\s|=|>)|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0(?:\.0+)?(?![\d.])|left\s*:\s*-\d{3,}))/i;

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'wbr']);

/** Removes elements carrying a hidden marker, including everything nested inside them. */
function stripHiddenElements(html: string): string {
  let out = html;
  for (let guard = 0; guard < 500; guard++) {
    const open = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
    let found: { start: number; end: number } | null = null;
    let m: RegExpExecArray | null;
    while ((m = open.exec(out))) {
      const tag = m[1].toLowerCase();
      if (VOID_TAGS.has(tag) || !HIDDEN_ATTR.test(' ' + m[2] + ' ')) continue;
      // find the matching close tag, counting nested same-name elements
      const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
      re.lastIndex = open.lastIndex;
      let depth = 1;
      let end = out.length; // unclosed: drop to the end of the document
      let t: RegExpExecArray | null;
      while ((t = re.exec(out))) {
        depth += t[1] ? -1 : 1;
        if (depth === 0) {
          end = re.lastIndex;
          break;
        }
      }
      found = { start: m.index, end };
      break;
    }
    if (!found) return out;
    out = out.slice(0, found.start) + ' ' + out.slice(found.end);
  }
  return out;
}

export interface PageFacts {
  title: string;
  metaDescription: string;
  /** Whitelisted schema.org LocalBusiness-style facts, already stringified. */
  structured: string[];
}

const LD_KEYS = ['name', 'telephone', 'openingHours', 'areaServed', 'priceRange', 'description', 'serviceType', 'paymentAccepted'];

function flattenLd(node: unknown, out: string[], depth = 0): void {
  if (depth > 4 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node.slice(0, 20)) flattenLd(n, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const key of LD_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' || typeof v === 'number') out.push(`${key}: ${String(v).slice(0, 200)}`);
    else if (Array.isArray(v)) {
      const strs = v.filter((x): x is string => typeof x === 'string').slice(0, 12);
      if (strs.length) out.push(`${key}: ${strs.join('; ').slice(0, 300)}`);
    } else if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).name === 'string') {
      out.push(`${key}: ${String((v as Record<string, unknown>).name).slice(0, 200)}`);
    }
  }
  const spec = obj.openingHoursSpecification;
  if (Array.isArray(spec)) {
    for (const s of spec.slice(0, 14)) {
      if (s && typeof s === 'object') {
        const r = s as Record<string, unknown>;
        const days = Array.isArray(r.dayOfWeek) ? r.dayOfWeek.join('/') : String(r.dayOfWeek ?? '');
        out.push(`hours: ${days} ${String(r.opens ?? '')}-${String(r.closes ?? '')}`.slice(0, 120));
      }
    }
  }
  if (obj['@graph']) flattenLd(obj['@graph'], out, depth + 1);
}

export function extractPageFacts(html: string): PageFacts {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim()).slice(0, 200);
  const metaDescription = decodeEntities(
    (/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim(),
  ).slice(0, 300);
  const structured: string[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(html)) && n++ < 6) {
    try {
      flattenLd(JSON.parse(m[1]), structured);
    } catch {
      // malformed JSON-LD is ignored
    }
  }
  return { title, metaDescription, structured: structured.slice(0, 60) };
}

/** HTML -> readable text. Never returns markup. */
export function htmlToText(html: string, maxChars: number = MAX_SOURCE_CHARS): string {
  let s = html.slice(0, 1_500_000);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg|iframe|object|embed|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = stripHiddenElements(s);
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/ul|\/ol|\/table)\b[^>]*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f​-‏‪-‮⁠-⁤﻿]/g, '');
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return s.slice(0, maxChars);
}

/** Same-site links likely to hold business facts, ranked, capped. */
const LINK_HINTS = /(service|about|contact|faq|pricing|price|rates|hours|area|coverage|emergency|financ|warrant|team|why|location)/i;

export function extractCandidateLinks(html: string, base: URL, limit = 5): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && seen.size < 200) {
    let u: URL;
    try {
      u = new URL(decodeEntities(m[1]), base);
    } catch {
      continue;
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|css|js)$/i.test(u.pathname)) continue;
    u.hash = '';
    u.search = '';
    const key = u.toString();
    if (seen.has(key) || u.pathname === '/' || u.pathname === base.pathname) continue;
    seen.add(key);
    if (LINK_HINTS.test(u.pathname)) out.push(key);
  }
  return out.sort((a, b) => a.length - b.length).slice(0, limit);
}

/**
 * Wraps text as inert data for a prompt. The label is generated by us (never
 * by the page) and any closing tag inside the text is neutralised.
 */
export function wrapUntrusted(label: string, text: string): string {
  const safeLabel = label.replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'source';
  const body = text.replace(/<\/?\s*untrusted_source[^>]*>/gi, '[tag removed]');
  return `<untrusted_source id="${safeLabel}">\n${body}\n</untrusted_source>`;
}

/** Collapses text for substring grounding checks (case, quotes, dashes, whitespace). */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Full page pipeline: facts header + readable body, capped, with steering
 * phrases defanged. Returns the text that is both shown to the model and used
 * to verify the model's quotes (so grounding checks see exactly what it saw).
 */
export function composeSourceText(html: string): { text: string; flags: string[] } {
  const facts = extractPageFacts(html);
  const head = [facts.title && `Title: ${facts.title}`, facts.metaDescription && `Description: ${facts.metaDescription}`, ...facts.structured]
    .filter(Boolean)
    .join('\n')
    .slice(0, 900);
  const body = htmlToText(html, MAX_SOURCE_CHARS);
  const { text, injectionFlags } = defangInjection(`${head}\n${body}`);
  return { text: text.slice(0, MAX_SOURCE_CHARS), flags: injectionFlags };
}
