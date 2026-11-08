#!/usr/bin/env node
// scripts/color/fix-surfaces.mjs — `npm run fix:surfaces` (dry run) / `npm run fix:surfaces -- --write`.
// Rewrites class-string literals that fail the surface-contrast gate using a fixed set of token-preserving candidates.
// A rewrite is applied ONLY if the rewritten literal measures >= 4.5:1 in all 4 themes against every page surface
// (same maths as check-surfaces.mjs). Everything it cannot fix is listed — never guessed. Idempotent. Commit first; review the diff.
//   1. translucent family tint   bg-X/N text-X            → text-X-strong   (else bg-X-subtle)
//   2. media overlay             bg-bg-secondary(/N) + bare text-white|black → bg-static-white(/N) + text-static-white|black
//   3. faded text                text-text-secondary/60    → text-text-muted (else text-text-secondary)
//   4. neutral tint              bg-border/N, bg-text-muted/N → bg-bg-tertiary
//   5. brand gradient            from-accent [via-*] to-cta + white/on-* → from-brand-from to-brand-to text-on-brand
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXEMPT, parseLiteral, evaluate, fails } from './surface-lib.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const WRITE = process.argv.includes('--write');
const FAMS = ['accent', 'cta', 'success', 'danger', 'warning', 'info'];
// A TRANSLUCENT static-* overlay is only a valid rewrite on a media/dark backdrop (the gate assumes dark for static-*).
// Without a media hint in the file the literal is left for a human (e.g. a chip on an accent tab is NOT on dark media).
const MEDIA_HINT = /video|<img|lightbox|backdrop|fixed inset|bg-overlay|bg-black|bg-static-black|<canvas|onDark|on-dark|scrim|photo|<Image/i;
let fileHasMedia = false;
const passes = (s) => !fails(evaluate(parseLiteral(s)));
const re = (src, flags = 'g') => new RegExp(src, flags);

/** candidate generators: (class string) => rewritten string | null */
// prefix-aware: a variant prefix P (e.g. `hover:`, `placeholder:`, `dark:`) is carried through every rewrite.
const tintPrefixes = (s, f) => [...s.matchAll(re(`(?<![\\w-])((?:[a-z0-9-]+:)*)bg-${f}/\\d+(?![\\w-])`))].map((m) => m[1]);
const textRe = (f, P) => re(`(?<![\\w:-])${P.replace(/[:-]/g, '\\$&')}text-${f}(?![\\w/-])`);
const translucentStatic = (next) => /bg-static-(white|black)\/\d+/.test(next) && !fileHasMedia;
const CANDIDATES = [
  // 1. translucent family tint (base or variant)  bg-X/N text-X  → text-X-strong
  (s) => { for (const f of FAMS) { for (const P of [...new Set(tintPrefixes(s, f))]) { if (textRe(f, '').test(s)) return s.replace(textRe(f, ''), `text-${f}-strong`); if (P && textRe(f, P).test(s)) return s.replace(textRe(f, P), `${P}text-${f}-strong`); } } return null; },
  // 1b. … else bg-X/N → bg-X-subtle
  (s) => { for (const f of FAMS) { for (const P of [...new Set(tintPrefixes(s, f))]) { if (textRe(f, '').test(s) || (P && textRe(f, P).test(s))) return s.replace(re(`(?<![\\w-])${P.replace(/[:-]/g, '\\$&')}bg-${f}/\\d+(?![\\w-])`), `${P}bg-${f}-subtle`); } } return null; },
  // 2. media overlay damage from the codemod: bg-bg-secondary(/N) + bare white/black text → static tokens
  (s) => (/(?<![\w:-])bg-bg-secondary(\/\d+)?(?![\w-])/.test(s) && /(?<![\w:-])text-(white|black)(?![\w/-])/.test(s)
    ? s.replace(/(?<![\w:-])bg-bg-secondary(\/\d+)?(?![\w-])/g, 'bg-static-white$1').replace(/(?<![\w:-])text-(white|black)(?![\w/-])/g, 'text-static-$1') : null),
  // 2b. … and its hover/focus twin on a static-white overlay
  (s) => (/(?<![\w:-])bg-static-white/.test(s) && /(?<![\w-])(?:[a-z0-9-]+:)+bg-bg-secondary\/\d+/.test(s) ? s.replace(/(?<![\w-])((?:[a-z0-9-]+:)+)bg-bg-secondary(\/\d+)/g, '$1bg-static-white$2') : null),
  // 3. faded text (base or variant such as placeholder:)  text-text-secondary/60 → text-text-muted (else text-text-secondary)
  (s) => (/(?<![\w-])(?:[a-z0-9-]+:)*text-text-(secondary|muted)\/\d+(?![\w-])/.test(s) ? s.replace(/(?<![\w-])((?:[a-z0-9-]+:)*)text-text-(secondary|muted)\/\d+(?![\w-])/g, '$1text-text-muted') : null),
  (s) => (/(?<![\w-])(?:[a-z0-9-]+:)*text-text-(secondary|muted)\/\d+(?![\w-])/.test(s) ? s.replace(/(?<![\w-])((?:[a-z0-9-]+:)*)text-text-(secondary|muted)\/\d+(?![\w-])/g, '$1text-text-secondary') : null),
  // 4. neutral tint
  (s) => (/(?<![\w-])(?:[a-z0-9-]+:)*bg-(border|text-muted)\/\d+(?![\w-])/.test(s) ? s.replace(/(?<![\w-])((?:[a-z0-9-]+:)*)bg-(border|text-muted)\/\d+(?![\w-])/g, '$1bg-bg-tertiary') : null),
  // 5. hover fill must be the hover token, not the text-oriented -strong
  (s) => (/(?<![\w-])hover:bg-(accent|cta|success|danger|warning|info)-strong(?![\w-])/.test(s) ? s.replace(/(?<![\w-])hover:bg-(accent|cta|success|danger|warning|info)-strong(?![\w-])/g, 'hover:bg-$1-hover') : null),
  // 6. brand gradient
  (s) => (/(?<![\w:-])bg-gradient-to-/.test(s) && /(?<![\w:-])from-accent(?![\w/-])/.test(s) && /(?<![\w:-])to-cta(?![\w/-])/.test(s)
    ? s.replace(/(?<![\w:-])from-accent(?![\w/-])/, 'from-brand-from').replace(/(?<![\w:-])to-cta(?![\w/-])/, 'to-brand-to').replace(/\s*(?<![\w:-])via-[\w/.-]+/g, '')
        .replace(/(?<![\w:-])text-(?:white|on-accent|on-cta|static-white)(?![\w/-])/g, 'text-on-brand') : null),
  // 7. media overlay, base + hover/focus twin together (neither alone passes: the twin is judged in its own state)
  (s) => (/(?<![\w:-])bg-bg-secondary(\/\d+)?(?![\w-])/.test(s) && /(?<![\w:-])text-(white|black)(?![\w/-])/.test(s) && /(?<![\w-])(?:[a-z0-9-]+:)+bg-bg-secondary\/\d+/.test(s)
    ? s.replace(/(?<![\w-])((?:[a-z0-9-]+:)*)bg-bg-secondary(\/\d+)?(?![\w-])/g, '$1bg-static-white$2').replace(/(?<![\w:-])text-(white|black)(?![\w/-])/g, 'text-static-$1') : null),
  // 8. translucent inverse surface / scrim on a text label → opaque (a scrim over an unknown backdrop cannot be gated)
  (s) => (/(?<![\w-])(?:[a-z0-9-]+:)*bg-(surface-inverse|overlay)\/\d+(?![\w-])/.test(s) ? s.replace(/(?<![\w-])((?:[a-z0-9-]+:)*)bg-(surface-inverse|overlay)\/\d+(?![\w-])/g, '$1bg-$2') : null),
  // 9. hover fill that is the raw border colour → a 30% tint of it (keeps the label ≥ 4.5:1 in high-contrast)
  (s) => (/(?<![\w-])hover:bg-border(?![\w/-])/.test(s) ? s.replace(/(?<![\w-])hover:bg-border(?![\w/-])/g, 'hover:bg-border/30') : null),
];

const RULES = ['tint: text-X → text-X-strong', 'tint: bg-X/N → bg-X-subtle', 'media overlay: bg-bg-secondary + white/black → static tokens', 'media overlay hover/focus twin → static-white',
  'faded text → text-text-muted', 'faded text → text-text-secondary', 'neutral tint → bg-bg-tertiary', 'hover:bg-X-strong → hover:bg-X-hover', 'brand gradient → brand-from/to + text-on-brand', 'media overlay base + hover twin → static tokens', 'translucent inverse/scrim → opaque', 'hover:bg-border → hover:bg-border/30'];
// rules whose result changes how a surface LOOKS (not only its text tone) — every one is listed before→after for human review
const VISUAL_RISK = new Set([1, 2, 3, 6, 7, 8, 9, 10, 11]);
const applied = [];
let fixed = 0, scanned = 0; const unresolved = []; const touched = new Set();
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { if (e !== 'node_modules') walk(full); continue; }
    if (!['.ts', '.tsx'].includes(extname(e)) || EXEMPT.test(full)) continue;
    const rel = relative(ROOT, full).split(sep).join('/');
    const src = readFileSync(full, 'utf8');
    fileHasMedia = MEDIA_HINT.test(src);
    const out = src.split('\n').map((line, i) => {
      if (/surface-ok:/.test(line)) return line;
      return line.split(/([`'"]|\$\{|\})/).map((seg, idx) => {
        if (idx % 2 === 1 || !/\b(?:dark:)?(?:bg|from|via|to)-/.test(seg) || !/(?:^|\s)(?:dark:)?text-/.test(seg)) return seg;
        scanned++;
        if (passes(seg)) return seg;
        for (const [ci, cand] of CANDIDATES.entries()) { const next = cand(seg); if (next && next !== seg && !translucentStatic(next) && passes(next)) { fixed++; touched.add(rel); applied.push({ ci, rel, line: i + 1, before: seg.trim(), after: next.trim() }); return next; } }
        const w = evaluate(parseLiteral(seg)); unresolved.push(`${rel}:${i + 1}  ${w.ratio.toFixed(2)}:1 (need ${w.min}) [${w.theme}/${w.kind}/${w.scenario}] ${w.fg} on ${w.bg}`);
        return seg;
      }).join('');
    }).join('\n');
    if (WRITE && out !== src) writeFileSync(full, out);
  }
})(join(ROOT, 'src'));
if (WRITE) {
  const trim = (s) => s.replace(/\s+/g, ' ').slice(0, 130);
  const md = ['# Surface-contrast autofix — review report', '', `Generated by \`npm run fix:surfaces -- --write\`. Literals scanned: ${scanned}; rewritten: ${fixed} in ${touched.size} files; needs a human: ${unresolved.length}.`,
    'Every rewrite was verified ≥ 4.5:1 (icons ≥ 3:1) in all 4 themes before being applied — but contrast is not taste: review the rules marked **visual** by eye (light + dark).', '',
    '| # | rule | visual | rewrites | files |', '|---|---|---|---|---|'];
  RULES.forEach((r, ci) => { const a = applied.filter((x) => x.ci === ci); md.push(`| ${ci + 1} | ${r} | ${VISUAL_RISK.has(ci) ? '**yes**' : 'no'} | ${a.length} | ${new Set(a.map((x) => x.rel)).size} |`); });
  for (const ci of [...VISUAL_RISK]) {
    const a = applied.filter((x) => x.ci === ci); if (!a.length) continue;
    md.push('', `## ${ci + 1}. ${RULES[ci]} (${a.length})`, '');
    for (const x of a.slice(0, 60)) md.push(`- \`${x.rel}:${x.line}\`  \`${trim(x.before)}\` → \`${trim(x.after)}\``);
    if (a.length > 60) md.push(`- … and ${a.length - 60} more (same rule)`);
  }
  if (unresolved.length) md.push('', '## Needs a human', '', ...unresolved.map((u) => `- ${u}`));
  writeFileSync(join(ROOT, 'docs', 'design', 'SURFACE_FIX_REPORT.md'), md.join('\n') + '\n');
}
console.log(`${WRITE ? 'WROTE' : 'DRY RUN'}: literals scanned=${scanned} fixed=${fixed} files=${touched.size} unresolved=${unresolved.length}`);
if (unresolved.length) { console.log('\nNeeds a human (no verified token-preserving rewrite):'); for (const u of unresolved) console.log('  ' + u); }
