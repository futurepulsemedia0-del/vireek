// checks/trust.mjs — trust & claims. Scores only what code can fix (trust surface + claim hygiene).
// Evidence-gated claims (certifications, stats, ratings, customer counts, testimonials) are LISTED, never scored,
// unless docs/claims-register.json holds a current evidence entry for that claim id.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, walk, stripComments, tryRead, finding, pct, round1 } from '../lib/util.mjs';
import { TRUST_SURFACE } from '../config.mjs';

export const CLAIMS = [
  { id: 'cert:soc2', kind: 'evidence', label: 'SOC 2 claim', re: /\bSOC ?2\b/ },
  { id: 'cert:iso27001', kind: 'evidence', label: 'ISO 27001 claim', re: /\bISO[ /]?(?:IEC )?27001\b/ },
  { id: 'cert:hipaa', kind: 'evidence', label: 'HIPAA compliance claim', re: /\bHIPAA[- ]?(?:compliant|compliance|certified|ready|eligible)\b/i },
  { id: 'cert:pci', kind: 'evidence', label: 'PCI compliance claim', re: /\bPCI[- ]?(?:DSS)?[- ]?(?:compliant|certified|level ?\d)\b/i },
  { id: 'cert:gdpr', kind: 'evidence', label: 'GDPR compliance/certification claim', re: /\bGDPR[- ](?:compliant|certified)\b/i },
  { id: 'cert:wcag', kind: 'evidence', label: 'WCAG conformance claim', re: /\bWCAG [\d.]+ ?(?:AA|AAA)\b[^.<]{0,40}(?:conform|compliant|certified)/i },
  { id: 'stat:uptime', kind: 'evidence', label: 'Uptime/availability figure', re: /\b99\.\d{1,3}%\s*(?:uptime|availability)?/i },
  { id: 'stat:rating', kind: 'evidence', label: 'Rating / review claim', re: /\b[1-5](?:\.\d)?\s*(?:\/\s*5|stars?)\b|★{3,}/i },
  { id: 'stat:customers', kind: 'evidence', label: 'Customer-count claim', re: /\b(?:trusted by|used by|serving)\s+\d[\d,]*\+?\s+(?:businesses|contractors|customers|companies|teams)\b/i },
  { id: 'claim:absolute', kind: 'hygiene', label: 'Unqualified absolute claim', re: /\b(?:100% (?:accurate|secure|uptime|reliable)|never (?:miss|misses|drops?) (?:a|an|another|any)\s+(?:call|job|lead|customer|booking|emergency)|zero downtime|unhackable|bank-grade|military-grade)\b/i },
  { id: 'claim:superlative', kind: 'hygiene', label: 'Unqualified superlative', re: /(?:^|[\s"'>(])#1 (?:in|rated|choice|platform|reason|ai|provider|voice|receptionist)\b|\bbest[- ](?:in[- ]class|rated|selling)\b|\b(?:world's|industry's) (?:first|best|only|leading)\b/i },
];

/** Pure: register entry is current evidence only with owner, URL and a valid date window. */
export function entryCovers(entry, now = new Date()) {
  if (!entry?.evidence?.url || !entry.evidence.owner) return false;
  if (entry.evidence.expiresAt) return new Date(entry.evidence.expiresAt) > now;
  const issued = entry.evidence.issuedAt && new Date(entry.evidence.issuedAt);
  return Boolean(issued) && now - issued < 540 * 864e5;
}

export function scanClaims(src) {
  const out = [];
  src.split('\n').forEach((line, i) => { for (const c of CLAIMS) { const m = c.re.exec(line); if (m) out.push({ id: c.id, line: i + 1, text: line.trim().slice(0, 110) }); } });
  return out;
}

export async function run() {
  let register = { claims: [] };
  try { register = JSON.parse(tryRead('docs/claims-register.json') ?? '{"claims":[]}'); } catch { /* invalid register = no coverage */ }
  const covered = new Set((register.claims ?? []).filter((e) => entryCovers(e)).map((e) => e.id));
  const hits = [];
  const files = [...walk('src', { exts: ['.ts', '.tsx'], skipTests: true }), ...walk('src/locales', { exts: ['.json'] })];
  for (const f of new Set(files)) {
    if (f.includes('/dev/') || /pages\/(TokensPreview|BrandGuidelinesPage)/.test(f) || /\/(lib\/brandFacts|lib\/aiDisclosureLedger)/.test(f)) continue;
    const raw = readFileSync(join(ROOT, f), 'utf8');
    for (const h of scanClaims(f.endsWith('.json') ? raw : stripComments(raw))) hits.push({ file: f, ...h });
  }
  const byId = (id) => hits.filter((h) => h.id === id);
  const hygiene = CLAIMS.filter((c) => c.kind === 'hygiene').flatMap((c) => byId(c.id));
  const evidenceClaims = CLAIMS.filter((c) => c.kind === 'evidence').map((c) => ({ ...c, hits: byId(c.id), covered: covered.has(c.id) })).filter((c) => c.hits.length);

  const routerSrc = tryRead('src/App.tsx') ?? '';
  const present = TRUST_SURFACE.filter((p) => routerSrc.includes(`path="${p}"`));
  const missingSurface = TRUST_SURFACE.filter((p) => !present.includes(p));
  const components = [
    { name: 'Trust surface pages exist (trust, security, DPA, SLA, status, …)', weight: 50, score: round1(pct(present.length, TRUST_SURFACE.length)), detail: missingSurface.length ? `missing: ${missingSurface.join(', ')}` : 'all present' },
    { name: 'Claim hygiene: no unqualified absolutes / superlatives', weight: 50, score: Math.max(0, 100 - 10 * hygiene.length), detail: `${hygiene.length} occurrence(s) to qualify or remove` },
  ];
  const findings = [];
  if (hygiene.length) findings.push(finding({ id: 'trust/hygiene', category: 'trust', severity: 'high', title: `${hygiene.length} unqualified absolute/superlative claim(s)`, detail: 'Qualify with scope + date + source, or remove. These are copy fixes, not evidence gaps.', refs: hygiene.map((h) => ({ file: h.file, line: h.line, text: h.text })), count: hygiene.length }));
  missingSurface.forEach((p) => findings.push(finding({ id: 'trust/surface', category: 'trust', severity: 'medium', title: `Trust page missing from router: ${p}`, refs: [{ route: p }], count: 1 })));
  const needsEvidence = evidenceClaims.filter((c) => !c.covered).map((c) => ({ id: c.id, label: c.label, occurrences: c.hits.length, refs: c.hits.slice(0, 25).map(({ file, line, text }) => ({ file, line, text })) }));
  return { category: 'trust', components, metrics: { evidenceClaimsDetected: evidenceClaims.length, evidenceClaimsCovered: evidenceClaims.filter((c) => c.covered).length, registerEntries: (register.claims ?? []).length }, findings, needsEvidenceDetected: needsEvidence };
}
