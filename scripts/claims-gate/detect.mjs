// scripts/claims-gate/detect.mjs
//
// Finds NUMERIC and COMPARATIVE marketing claims in prose. Pure functions, no file-system access, no dependencies.
//
//   numeric      "40% more booked jobs", "3x faster", "trusted by 500 contractors", "save 10 hours a week"
//   comparative  "faster than a voicemail", "the most accurate", "#1 AI receptionist", "costs less than a hire"
//
// This is a conservative net, not a judge: it flags wording that LOOKS like a measurable or competitive claim and
// asks for a register entry (docs/claims-register.json). It cannot prove a claim true, and it will miss claims
// phrased in ways the patterns do not cover (see docs/compliance/claims-gate.md, "What this does not catch").

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const NOUNS = String.raw`(?:contractors?|businesses|customers?|companies|teams?|technicians?|calls|jobs|appointments|reviews|users|shops|homeowners|trades)`;

/** id → pattern. Every pattern is case-insensitive and tested per prose segment. */
export const CLAIM_PATTERNS = [
  // ---- numeric ----------------------------------------------------------------------------------------------
  { id: 'num.percent', kind: 'numeric', re: new RegExp(String.raw`(?<![\w.])${NUM}\s?(?:%|percent\b)`, 'gi') },
  { id: 'num.multiplier', kind: 'numeric', re: new RegExp(String.raw`(?<![\w.])${NUM}\s?[x×](?![\w-])|(?<![\w.])${NUM}\s?times\s+(?:faster|more|as|better|higher|lower|fewer)\b|\b(?:two|three|four|five|ten)[- ]?(?:fold|times\s+(?:faster|more|as|better))\b`, 'gi') },
  { id: 'num.social-proof', kind: 'numeric', re: new RegExp(String.raw`\b(?:trusted by|used by|serving|serves|helping|helped|powering|handled|answered|booked|over|more than)\s+\$?${NUM}\+?\s?(?:k|m|million|thousand)?\s+${NOUNS}\b|(?<![\w.])${NUM}\+\s+${NOUNS}\b`, 'gi') },
  { id: 'num.savings', kind: 'numeric', re: new RegExp(String.raw`\b(?:save[sd]?|saving|recover(?:s|ed)?|earn(?:s|ed)?|add(?:s|ed)?|gain(?:s|ed)?)\s+(?:up to\s+|an average of\s+|about\s+|over\s+|around\s+)?(?:\$\s?${NUM}\s?[km]?|${NUM}\s*(?:hours?|hrs?|minutes?|days?|weeks?))\b`, 'gi') },
  { id: 'num.speed', kind: 'numeric', re: new RegExp(String.raw`\b(?:answer(?:s|ed)?|respond(?:s|ed)?|response|pick(?:s)? up|set ?up|go(?:es)? live|launch(?:es)?|book(?:s|ed)?)\b[^.!?]{0,40}?\b(?:in|within|under|less than)\s+${NUM}\s*(?:seconds?|secs?|ms|minutes?)\b`, 'gi') },
  { id: 'num.ratio', kind: 'numeric', re: new RegExp(String.raw`\b${NUM}\s+(?:out of|in)\s+${NUM}\s+(?:customers|contractors|calls|callers|businesses|owners)\b`, 'gi') },
  { id: 'num.rating', kind: 'numeric', re: /(?<![\w./-])[1-5](?:\.\d)?\s*(?:\/\s*5|stars?)\b|★{3,}/gi },
  // ---- comparative ------------------------------------------------------------------------------------------
  { id: 'cmp.than', kind: 'comparative', re: /\b(?:faster|quicker|cheaper|better|more (?:accurate|reliable|affordable)|less expensive|lower[- ]cost)\s+than\b/gi },
  { id: 'cmp.cost-less', kind: 'comparative', re: /\b(?:costs?|priced?)\s+(?:far |much |significantly |a lot )?(?:less|lower) than\b/gi },
  { id: 'cmp.beats', kind: 'comparative', re: /\b(?:outperforms?|outpaces?)\b|\bbeats\s+(?:every|any|all|other|the competition|competitors?|voicemail|answering services?)\b/gi },
  { id: 'cmp.superlative', kind: 'comparative', re: /(?<![\w#])#1(?![\w.])|\b(?:the )?(?:(?:fastest|cheapest|most accurate|most reliable|most affordable)\s+(?:ai|option|solution|platform|receptionist|answering|service|tool|software|provider|choice|plan)s?|number one|top[- ]rated|best[- ](?:in[- ]class|rated|selling|value)|industry[- ]leading|market[- ]leading|world['’]s (?:first|best|only|leading)|the only (?:ai|platform|receptionist|voice|software|tool|solution))\b/gi },
];

export const CLAIM_IDS = CLAIM_PATTERNS.map((p) => p.id);

// ---------------------------------------------------------------------------------------------------------------
// Normalisation (used for both detection context and register matching)
// ---------------------------------------------------------------------------------------------------------------

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&mdash;': '-', '&ndash;': '-', '&rsquo;': "'", '&lsquo;': "'", '&ldquo;': '"', '&rdquo;': '"', '&#39;': "'", '&quot;': '"' };

/** Lower-case, strip markup/escapes/quotes, unify "%", "x" and apostrophes, collapse whitespace. */
export function normalize(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ')
    .replace(/\\u2019|\\u2018|[’‘]/g, "'")
    .replace(/\\u00d7|×/g, 'x')
    .replace(/\\["'`n]/g, ' ')
    .replace(/[*_`~>#|]+/g, (m) => (m === '#' ? m : ' '))
    .replace(/(\d)\s+(%|percent\b)/gi, '$1$2')
    .replace(/(\d)\s+x\b/gi, '$1x')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------------------------------------------
// Prose extraction: which parts of a source line are visitor-facing words, not code?
// ---------------------------------------------------------------------------------------------------------------

/** Looks like a Tailwind/CSS class list: most whitespace-separated tokens are hyphenated or use ":" / "/" / "[...]". */
function looksLikeClassList(s) {
  const tokens = s.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  const classy = tokens.filter((t) => /^[!\w:\[\]\-\/.%]+$/.test(t) && /[-:/]/.test(t)).length;
  return classy / tokens.length >= 0.6;
}

/**
 * A string is "prose" (visitor-facing words) when it has at least two words, or one word plus a number (badge
 * text such as "99.9% uptime"), and none of the punctuation, units and shapes that code, CSS or class lists carry.
 */
export function isProse(s) {
  if (/[{}\[\];]|=>|\$\{/.test(s)) return false;
  // CSS values and units carry percentages that are not claims: gradients, colour functions, var(--x), 12px / 1.5rem
  if (/\b(?:radial|linear|conic|repeating-linear)-gradient\(|\brgba?\(|\bhsla?\(|\bvar\(--|\bcalc\(|\d(?:px|rem|em|vh|vw|ms)\b/i.test(s)) return false;
  if (/^\s*(?:https?:\/\/|\/|\.\.?\/|@\/|#[0-9a-f]{3,8}\b)/i.test(s)) return false;
  if (looksLikeClassList(s)) return false;
  const words = (s.match(/[A-Za-z]{2,}/g) ?? []).length;
  const tokens = s.trim().split(/\s+/).length;
  return words >= 2 || (words >= 1 && tokens >= 2);
}

/** Replace comments with spaces, keeping every newline so line numbers stay correct. */
export function blankComments(src, ext) {
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) return src;
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length));
}

function stringLiterals(line) {
  const out = [];
  for (const m of line.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) out.push(m[2]);
  return out;
}

/**
 * Prose candidates for every line of a file: Array<string[]> (index = line - 1). `ext` selects the dialect.
 * Markdown: lines outside code fences. HTML: text outside script/style. JSON: string values (not keys).
 * TS/TSX: string literals, JSX text between tags, and bare wrapped-text lines.
 */
export function proseByLine(text, ext) {
  const src = blankComments(text.replace(/\r\n?/g, '\n'), ext);
  const lines = src.split('\n');
  const out = lines.map(() => []);
  const push = (i, s) => { if (isProse(s)) out[i].push(s); };

  if (ext === '.md' || ext === '.txt') {
    let fence = false;
    lines.forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
      if (fence || /^\s*\|?\s*:?-{3,}/.test(l)) return;
      push(i, l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
    });
  } else if (ext === '.html') {
    let skip = false;
    lines.forEach((l, i) => {
      if (/<(script|style)\b/i.test(l) && !/<\/(script|style)>/i.test(l)) skip = true;
      if (!skip) push(i, l.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));
      if (/<\/(script|style)>/i.test(l)) skip = false;
    });
  } else if (ext === '.json') {
    lines.forEach((l, i) => {
      // left-to-right, non-overlapping string tokens; a string followed by ":" is a key, not copy
      for (const m of l.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
        if (l.slice(m.index + m[0].length).trimStart()[0] !== ':') push(i, m[1]);
      }
    });
  } else {
    lines.forEach((l, i) => {
      for (const s of stringLiterals(l)) push(i, s);
      for (const m of l.matchAll(/>([^<>{}]+)</g)) push(i, m[1]);
      // wrapped JSX / template text: a line with no code punctuation at all
      if (!/[<>{}=()\[\];"'`]/.test(l)) push(i, l.trim());
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------------------------

/**
 * @returns {{ line: number, id: string, kind: 'numeric'|'comparative', token: string, context: string }[]}
 * `context` is the normalized prose of the line plus its neighbours, so a claim wrapped over several lines still
 * matches a register phrase.
 */
export function scanText(text, ext) {
  const prose = proseByLine(text, ext);
  const hits = [];
  prose.forEach((segments, i) => {
    if (!segments.length) return;
    const context = normalize([prose[i - 1] ?? [], segments, prose[i + 1] ?? []].flat().join(' '));
    for (const seg of segments) {
      for (const p of CLAIM_PATTERNS) {
        for (const m of seg.matchAll(p.re)) {
          hits.push({ line: i + 1, id: p.id, kind: p.kind, token: normalize(m[0]), context });
        }
      }
    }
  });
  // one finding per (line, token): overlapping patterns must not double-report
  const seen = new Set();
  return hits.filter((h) => (seen.has(`${h.line}|${h.token}`) ? false : seen.add(`${h.line}|${h.token}`)));
}
