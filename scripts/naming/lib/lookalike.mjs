// Lookalike screening: Levenshtein distance + a simple phonetic key against a configurable
// brand list. Heuristic only: a "none" result does NOT mean a name is clear of conflicts.

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Simple, vowel-agnostic phonetic key (Metaphone-like). Consonant sounds are normalised and every
 * vowel group becomes a single "a", so "vireek" and "farik" share a key.
 */
export function phoneticKey(raw) {
  let s = String(raw).toLowerCase().replace(/[^a-z]/g, '');
  s = s
    .replace(/^(kn|gn|pn)/, 'n')
    .replace(/^wr/, 'r')
    .replace(/^wh/, 'w')
    .replace(/^x/, 's')
    .replace(/sch/g, 'sk')
    .replace(/tch|ch|sh/g, 'x')
    .replace(/ph/g, 'f')
    .replace(/gh(?=t)/g, '')
    .replace(/gh/g, 'g')
    .replace(/ck/g, 'k')
    .replace(/th/g, 't')
    .replace(/dg/g, 'j')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/v/g, 'f')
    .replace(/([^aeiouy])e$/, '$1');
  s = s.replace(/[aeiouy]+/g, 'a').replace(/([^a])\1+/g, '$1');
  return s;
}

/** Accepts an array or {brands: []}; entries are strings or {name}. Letters only, 3+ chars. */
export function normalizeBrandList(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.brands) ? raw.brands : [];
  const names = list
    .map((b) => (typeof b === 'string' ? b : b && typeof b.name === 'string' ? b.name : ''))
    .map((b) => b.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]/g, ''))
    .filter((b) => b.length >= 3);
  return [...new Set(names)];
}

const LEVEL_SCORE = { identical: 100, high: 85, medium: 55, low: 25, none: 0 };

/** Compare one name with one brand. */
export function compareToBrand(name, brand) {
  const distance = levenshtein(name, brand);
  const maxLen = Math.max(name.length, brand.length);
  const similarity = 1 - distance / maxLen;
  const keyName = phoneticKey(name);
  const keyBrand = phoneticKey(brand);
  const phoneticMatch = keyName === keyBrand && keyName.length >= 3;
  const phoneticClose =
    levenshtein(keyName, keyBrand) <= 1 && keyName.length >= 4 && keyBrand.length >= 4;
  const [short, long] = name.length <= brand.length ? [name, brand] : [brand, name];
  const contains = distance > 0 && short.length >= 4 && long.includes(short);

  let level = 'none';
  if (distance === 0) level = 'identical';
  else if (distance === 1 || (phoneticMatch && similarity >= 0.5) || (contains && short.length >= 5)) {
    level = 'high';
  } else if (
    (distance === 2 && maxLen >= 5) ||
    similarity >= 0.7 ||
    phoneticMatch ||
    phoneticClose ||
    contains
  ) {
    level = 'medium';
  } else if (similarity >= 0.6) level = 'low';

  return {
    brand,
    distance,
    similarity: Math.round(similarity * 100) / 100,
    phoneticMatch,
    contains,
    level,
    score: LEVEL_SCORE[level],
  };
}

/**
 * @returns {{riskScore: number, level: string, matches: object[]}} riskScore 0-100, higher = worse.
 */
export function findLookalikes(name, brands, { limit = 5 } = {}) {
  const matches = brands
    .map((b) => compareToBrand(name, b))
    .filter((m) => m.level !== 'none')
    .sort((a, b) => b.score - a.score || b.similarity - a.similarity || a.brand.localeCompare(b.brand));
  if (!matches.length) return { riskScore: 0, level: 'none', matches: [] };
  const extra = matches.slice(1).filter((m) => m.score >= LEVEL_SCORE.medium).length;
  return {
    riskScore: Math.min(100, matches[0].score + 5 * extra),
    level: matches[0].level,
    matches: matches.slice(0, limit),
  };
}
