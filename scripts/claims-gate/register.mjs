// scripts/claims-gate/register.mjs
//
// Reads docs/claims-register.json and decides, for each detected claim, whether it is covered by CURRENT evidence.
// Pure: no file-system, no network, `now` is injected. The register shape stays compatible with the existing
// brand-audit reader (scripts/brand-audit/checks/trust.mjs): id, claim, evidence.{url,owner,issuedAt,expiresAt}.
import { normalize } from './detect.mjs';

export const MAX_EVIDENCE_WINDOW_DAYS = 540; // same 18-month ceiling the brand audit uses for issuedAt-only entries
export const EXPIRY_WARNING_DAYS = 30;
const DAY = 864e5;
const ID_RE = /^[a-z0-9][a-z0-9:._-]*$/i;

const isoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const dayMs = (s) => Date.parse(`${s}T00:00:00Z`);

/** Problems with a single evidence block. Empty array = structurally valid (expiry is judged separately). */
export function evidenceProblems(ev, now = new Date()) {
  const out = [];
  if (!ev || typeof ev !== 'object') return ['evidence block missing'];
  let u = null;
  try { u = new URL(String(ev.url)); } catch { /* handled below */ }
  if (!u || u.protocol !== 'https:' || !u.hostname.includes('.') || /^(localhost|127\.|0\.0\.0\.0)/.test(u.hostname)) {
    out.push('evidence.url must be an absolute https:// link to the proof');
  }
  if (typeof ev.owner !== 'string' || ev.owner.trim().length < 2) out.push('evidence.owner is required');
  if (!isoDate(ev.issuedAt)) out.push('evidence.issuedAt must be a real YYYY-MM-DD date');
  else if (dayMs(ev.issuedAt) > now.getTime()) out.push('evidence.issuedAt is in the future');
  if (!isoDate(ev.expiresAt)) out.push('evidence.expiresAt must be a real YYYY-MM-DD date');
  if (isoDate(ev.issuedAt) && isoDate(ev.expiresAt)) {
    const span = (dayMs(ev.expiresAt) - dayMs(ev.issuedAt)) / DAY;
    if (span <= 0) out.push('evidence.expiresAt must be after evidence.issuedAt');
    else if (span > MAX_EVIDENCE_WINDOW_DAYS) out.push(`evidence window is ${Math.round(span)} days (max ${MAX_EVIDENCE_WINDOW_DAYS})`);
  }
  return out;
}

/** true when the evidence has not expired yet. Same boundary as the brand audit: valid until 00:00 UTC of expiresAt. */
export const isCurrent = (ev, now = new Date()) => isoDate(ev?.expiresAt) && dayMs(ev.expiresAt) > now.getTime();

const phrases = (e) => [e.claim, ...(Array.isArray(e.match) ? e.match : [])].filter((p) => typeof p === 'string').map(normalize).filter(Boolean);

/**
 * Validate the whole register.
 * errors   → the register itself is broken (CI fails even if no copy uses the entry)
 * warnings → hygiene (unused entry, expiring soon) — never fail CI
 */
export function validateRegister(register, now = new Date()) {
  const errors = [];
  const warnings = [];
  const claims = Array.isArray(register?.claims) ? register.claims : null;
  const exemptions = register?.exemptions === undefined ? [] : register.exemptions;
  if (!claims) errors.push('register: "claims" must be an array');
  if (!Array.isArray(exemptions)) errors.push('register: "exemptions" must be an array');
  if (errors.length) return { errors, warnings, claims: [], exemptions: [] };

  const ids = new Set();
  const checkId = (e, where) => {
    if (typeof e?.id !== 'string' || !ID_RE.test(e.id)) { errors.push(`${where}: id must match ${ID_RE}`); return false; }
    if (ids.has(e.id)) { errors.push(`${where} "${e.id}": duplicate id`); return false; }
    ids.add(e.id);
    return true;
  };
  const checkMatch = (e, label) => {
    if (e.match !== undefined && (!Array.isArray(e.match) || e.match.some((m) => typeof m !== 'string' || normalize(m).length < 3))) {
      errors.push(`${label}: "match" must be an array of strings (3+ characters each)`);
    }
  };

  const okClaims = [];
  for (const [i, e] of claims.entries()) {
    const label = `claims[${i}]${e?.id ? ` "${e.id}"` : ''}`;
    if (!checkId(e, `claims[${i}]`)) continue;
    if (typeof e.claim !== 'string' || e.claim.trim().length < 5) errors.push(`${label}: "claim" (the exact wording) is required`);
    checkMatch(e, label);
    for (const p of evidenceProblems(e.evidence, now)) errors.push(`${label}: ${p}`);
    if (isCurrent(e.evidence, now)) {
      const left = Math.ceil((dayMs(e.evidence.expiresAt) - now.getTime()) / DAY);
      if (left <= EXPIRY_WARNING_DAYS) warnings.push(`${label}: evidence expires in ${left} day(s) (${e.evidence.expiresAt})`);
    }
    okClaims.push(e);
  }
  const okExemptions = [];
  for (const [i, e] of exemptions.entries()) {
    const label = `exemptions[${i}]${e?.id ? ` "${e.id}"` : ''}`;
    if (!checkId(e, `exemptions[${i}]`)) continue;
    if (!Array.isArray(e.match) || !e.match.length) errors.push(`${label}: "match" (the exact wording being exempted) is required`);
    else checkMatch(e, label);
    if (typeof e.reason !== 'string' || e.reason.trim().length < 15) errors.push(`${label}: "reason" must explain why this is not a claim (15+ characters)`);
    if (typeof e.owner !== 'string' || e.owner.trim().length < 2) errors.push(`${label}: "owner" is required`);
    okExemptions.push(e);
  }
  return { errors, warnings, claims: okClaims, exemptions: okExemptions };
}

/**
 * A register phrase covers a detection when the phrase appears in the detection's surrounding prose AND contains
 * the detected token itself. That binds the entry to the exact number or comparison, so a stale entry cannot cover
 * reworded copy ("40%" in the register does not cover "45%" in the page).
 */
const covers = (e, d, file) =>
  (!e.file || e.file === file) && phrases(e).some((p) => d.context.includes(p) && p.includes(d.token));

/**
 * @param {{ file: string, line: number, id: string, kind: string, token: string, context: string }[]} detections
 * @returns {{ violations: object[], covered: object[], exempt: object[], usedIds: Set<string>, unused: string[] }}
 */
export function evaluateDetections(detections, register, now = new Date()) {
  const { claims, exemptions } = validateRegister(register, now);
  const violations = [];
  const covered = [];
  const exempt = [];
  const usedIds = new Set();

  for (const d of detections) {
    const where = { file: d.file, line: d.line, pattern: d.id, kind: d.kind, token: d.token };
    const ex = exemptions.find((e) => covers(e, d, d.file));
    if (ex) { usedIds.add(ex.id); exempt.push({ ...where, entry: ex.id, reason: ex.reason }); continue; }

    const matches = claims.filter((e) => covers(e, d, d.file));
    if (!matches.length) {
      violations.push({ ...where, code: 'unmapped', message: `"${d.token}" has no claims-register entry (add one with real evidence, reword the copy, or remove it)` });
      continue;
    }
    const good = matches.find((e) => evidenceProblems(e.evidence, now).length === 0 && isCurrent(e.evidence, now));
    if (good) { usedIds.add(good.id); covered.push({ ...where, entry: good.id }); continue; }
    const e = matches[0];
    usedIds.add(e.id);
    const problems = evidenceProblems(e.evidence, now);
    violations.push(problems.length
      ? { ...where, code: 'incomplete-evidence', entry: e.id, message: `"${d.token}" is mapped to "${e.id}" but its evidence is incomplete: ${problems.join('; ')}` }
      : { ...where, code: 'expired', entry: e.id, message: `"${d.token}" is mapped to "${e.id}" whose evidence expired on ${e.evidence.expiresAt}` });
  }
  const unused = [...claims, ...exemptions].map((e) => e.id).filter((id) => !usedIds.has(id));
  return { violations, covered, exempt, usedIds, unused };
}
