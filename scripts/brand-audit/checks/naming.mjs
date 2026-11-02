// checks/naming.mjs — brand naming/trademark usage in user-facing source.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, walk, stripComments, finding, pct, round1 } from '../lib/util.mjs';
import { NAMING } from '../config.mjs';

/** Pure: findings for one source text. */
export function scanNaming(src) {
  const out = [];
  src.split('\n').forEach((line, i) => {
    if (/VITE_|VIREEK_[A-Z]|[A-Z_]VIREEK\b|schema:\s*'VIREEK'/.test(line)) return; // env vars / identifiers
    if (/\bVIREEK\b/.test(line)) out.push({ rule: 'allcaps', line: i + 1, text: 'VIREEK' });
    for (const m of line.matchAll(/\b([a-z0-9-]+\.)?vireek\.(?:com|ai|app|io|net|org|co|dev|us)\b/gi)) {
      const host = m[0].toLowerCase();
      if (host.endsWith(`.${NAMING.canonicalDomain}`) || host === NAMING.canonicalDomain) continue;
      if (NAMING.allowedOtherDomains.some((a) => line.includes(a))) continue;
      if (/^vireek\.ai_/.test(host) || /vireek\.ai_disclosure/.test(line)) continue; // report-type identifier, not a domain
      out.push({ rule: 'domain', line: i + 1, text: host });
    }
    for (const m of line.matchAll(/>[^<{]*(?<![\w-])vireek(?![\w.-])[^<{]*</g)) if (!/https?:|@vireek/.test(m[0])) out.push({ rule: 'lowercase', line: i + 1, text: m[0].slice(0, 60) });
  });
  return out;
}

export async function run() {
  let files = 0; const hits = [];
  for (const f of walk('src', { exts: ['.tsx', '.ts'], skipTests: true })) {
    if (f.startsWith('src/pages/dev/')) continue;
    files++;
    for (const h of scanNaming(stripComments(readFileSync(join(ROOT, f), 'utf8')))) hits.push({ file: f, ...h });
  }
  const bad = new Set(hits.map((h) => h.file));
  const by = (r) => hits.filter((h) => h.rule === r);
  const findings = [];
  const mk = (rule, sev, title, detail) => by(rule).length && findings.push(finding({ id: `naming/${rule}`, category: 'naming', severity: sev, title: `${title}: ${by(rule).length}`, detail, refs: by(rule).map((h) => ({ file: h.file, line: h.line, text: h.text })), count: by(rule).length }));
  mk('allcaps', 'low', 'Brand written as "VIREEK" in user-facing source', `Canonical form is "${NAMING.canonicalName}" (see /trademark-policy).`);
  mk('domain', 'medium', 'Non-canonical vireek.* domain in source', `Canonical domain is ${NAMING.canonicalDomain}. If intentional, add it to NAMING.allowedOtherDomains with owner sign-off.`);
  mk('lowercase', 'low', 'Lowercase "vireek" in visible text', 'Use "Vireek".');
  const aiName = hits.length >= 0 ? [...walk('src', { exts: ['.tsx'], skipTests: true })].filter((f) => /Vireek AI(?! Core| Call| Voice| receptionist)/.test(readFileSync(join(ROOT, f), 'utf8'))) : [];
  if (aiName.length) findings.push(finding({ id: 'naming/product-name-variant', category: 'naming', severity: 'info', title: `"Vireek AI" used as a name in ${aiName.length} file(s) — confirm it is an approved product name`, detail: 'Approved sub-brands live in NAMING.productNames (config.mjs).', refs: aiName.map((file) => ({ file })), count: aiName.length }));
  return { category: 'naming', components: [{ name: 'Files with canonical brand naming', weight: 100, score: round1(pct(files - bad.size, files)), detail: `${bad.size}/${files} files deviate` }], metrics: { files, deviating: bad.size }, findings };
}
