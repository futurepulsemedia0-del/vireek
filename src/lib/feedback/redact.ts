// Client-side redaction. Mirrors public.feedback_redact() in the 20281101000000 migration; the server
// re-redacts everything, so this copy only keeps PII out of previews and the network payload.
// Both implementations are checked against redactionFixtures.json.

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[token]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b(?:sk|pk|rk|whsec|ghp|gho|xox[abprs])[-_][A-Za-z0-9_-]{16,}/g, '[secret]'],
  [/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1'],
  [/\b(?:\d[ -]?){12,18}\d\b/g, '[number]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[id]'],
  [/(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '[phone]'],
  [/\+\d[\d\s.-]{7,}\d/g, '[phone]'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]'],
];

export function redactText(input: string): string {
  let out = input;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

/** Drops query/hash and replaces UUID / long numeric path segments with :id. */
export function sanitizeRoute(route: string): string {
  return route
    .replace(/[?#].*$/, '')
    .replace(/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '/:id')
    .replace(/\/\d{3,}/g, '/:id')
    .slice(0, 200);
}
