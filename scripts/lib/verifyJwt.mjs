// Pure helpers: keep supabase/config.toml `verify_jwt = false` entries in sync with the edge functions
// that declare (in their header comment) that they are deployed with --no-verify-jwt.
// Safety: a function is only auto-added when its source shows its own auth (signature / secret / token / user check).

const HEADER_RE = /^\s*\[functions\.("?)([A-Za-z0-9_-]+)\1\]\s*$/;
const VALUE_RE = /^\s*verify_jwt\s*=\s*(true|false)\s*(#.*)?$/;
const SELF_AUTH_RE =
  /cron.?secret|x-signature|signature|hmac|timingSafe|webhook.?secret|verifyWebhook|auth\.getUser|getUser\(|api.?key|bearer|x-[a-z-]*secret|rate.?limit|token|authorizeCron|_shared\/(http|auth)/i;

/** @returns {{ entries: Map<string, boolean>, duplicates: string[], preamble: string }} */
export function parseConfig(text) {
  const entries = new Map();
  const duplicates = [];
  const lines = text.split(/\r?\n/);
  let current = null;
  let firstHeader = -1;
  lines.forEach((line, i) => {
    const h = HEADER_RE.exec(line);
    if (h) {
      if (firstHeader < 0) firstHeader = i;
      current = h[2];
      if (entries.has(current)) duplicates.push(current);
      else entries.set(current, true); // default until a verify_jwt line says otherwise
      return;
    }
    const v = VALUE_RE.exec(line);
    if (v && current) entries.set(current, v[1] === 'true');
  });
  const preamble = firstHeader < 0 ? text.trimEnd() : lines.slice(0, firstHeader).join('\n').trimEnd();
  return { entries, duplicates: [...new Set(duplicates)], preamble };
}

/** Leading comment block of an edge function declares it is deployed without gateway JWT. */
export function declaresNoVerifyJwt(src) {
  const head = src.split(/\r?\n/).slice(0, 80).filter((l) => /^\s*\/\//.test(l)).join('\n');
  return /--no-verify-jwt/.test(head) || /verify_jwt\s*=\s*false/.test(head);
}

export function hasSelfAuthEvidence(src) {
  return SELF_AUTH_RE.test(src);
}

/**
 * @param {string} configText
 * @param {{ name: string, src: string }[]} fns
 */
export function computePlan(configText, fns) {
  const { entries, duplicates } = parseConfig(configText);
  const names = new Set(fns.map((f) => f.name));
  const toAdd = [];
  const needsReview = [];
  for (const f of fns) {
    if (!declaresNoVerifyJwt(f.src)) continue;
    if (entries.get(f.name) === false) continue;
    (hasSelfAuthEvidence(f.src) ? toAdd : needsReview).push(f.name);
  }
  const orphans = [...entries.keys()].filter((n) => !names.has(n));
  return { toAdd: toAdd.sort(), needsReview: needsReview.sort(), orphans: orphans.sort(), duplicates };
}

/** Rebuild the config: preamble kept, entries deduped + sorted, one canonical form. */
export function renderConfig(configText, addNames) {
  const { entries, preamble } = parseConfig(configText);
  for (const n of addNames) entries.set(n, false);
  const body = [...entries.keys()]
    .sort()
    .map((n) => `[functions.${n}]\nverify_jwt = ${entries.get(n) ? 'true' : 'false'}\n`)
    .join('\n');
  return `${preamble ? preamble + '\n\n' : ''}${body}`;
}
