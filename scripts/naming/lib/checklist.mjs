// Manual-verification checklist generator. Nothing here is automated or claims a result:
// every item starts as "NOT DONE" and must be completed by a human.

export const MANUAL_DEFAULT = 'NOT DONE';

/** Nice classes requested for Vireek-style SaaS (class headings are summaries, not legal advice). */
export const NICE_CLASSES = Object.freeze([
  { no: 9, summary: 'software and apps (downloadable / recorded)' },
  { no: 35, summary: 'business management and administration, advertising' },
  { no: 36, summary: 'financial, monetary and insurance affairs' },
  { no: 42, summary: 'technology services, software as a service' },
  { no: 44, summary: 'medical, health and veterinary services' },
]);

export const DATABASES = Object.freeze([
  {
    id: 'wipo',
    column: 'manual_wipo',
    label: 'WIPO Global Brand Database',
    urls: ['https://branddb.wipo.int/'],
  },
  {
    id: 'uspto',
    column: 'manual_uspto',
    label: 'USPTO Trademark Search',
    urls: ['https://tmsearch.uspto.gov/'],
  },
  {
    id: 'euipo_tmview',
    column: 'manual_euipo_tmview',
    label: 'EUIPO eSearch plus and TMview',
    urls: ['https://euipo.europa.eu/eSearch/', 'https://www.tmdn.org/tmview/'],
  },
]);

export const SOCIAL_PLATFORMS = Object.freeze([
  { id: 'instagram', label: 'Instagram', url: (h) => `https://www.instagram.com/${h}/` },
  { id: 'x', label: 'X', url: (h) => `https://x.com/${h}` },
  { id: 'linkedin', label: 'LinkedIn (company page)', url: (h) => `https://www.linkedin.com/company/${h}/` },
  { id: 'facebook', label: 'Facebook', url: (h) => `https://www.facebook.com/${h}` },
  { id: 'tiktok', label: 'TikTok', url: (h) => `https://www.tiktok.com/@${h}` },
  { id: 'youtube', label: 'YouTube', url: (h) => `https://www.youtube.com/@${h}` },
  { id: 'github', label: 'GitHub (organisation)', url: (h) => `https://github.com/${h}` },
]);

const VARIANT_SWAPS = [
  ['ph', 'f'],
  ['f', 'ph'],
  ['c', 'k'],
  ['k', 'c'],
  ['ck', 'k'],
  ['y', 'i'],
  ['i', 'y'],
  ['z', 's'],
  ['s', 'z'],
  ['x', 'ks'],
  ['ks', 'x'],
  ['ee', 'i'],
  ['ie', 'y'],
];

/** Plausible spelling / sound variants to search by hand (deterministic, max 8, excludes name). */
export function spellingVariants(name, max = 8) {
  const out = new Set();
  for (const [from, to] of VARIANT_SWAPS) {
    const i = name.indexOf(from);
    if (i === -1) continue;
    const v = name.slice(0, i) + to + name.slice(i + from.length);
    if (v !== name && /^[a-z]{3,}$/.test(v)) out.add(v);
  }
  return [...out].slice(0, max);
}

/** Registrar confirmation is required for every TLD whose RDAP signal was not "registered". */
export function buildChecklist(name, domains = []) {
  const searchTerms = [name, ...spellingVariants(name)];
  return {
    name,
    searchTerms,
    databases: DATABASES.map((d) => ({
      ...d,
      searchTerms,
      classes: NICE_CLASSES,
      status: MANUAL_DEFAULT,
    })),
    social: SOCIAL_PLATFORMS.map((p) => ({
      id: p.id,
      label: p.label,
      url: p.url(name),
      status: MANUAL_DEFAULT,
    })),
    registrarTlds: domains.filter((d) => d.status !== 'registered').map((d) => d.tld),
    other: [
      { id: 'meaning', label: 'Meaning / connotation review with native speakers (EN, ES, FR, DE, PT, AR, ZH, JA, HI)', status: MANUAL_DEFAULT },
      { id: 'attorney', label: 'Trademark clearance review by a qualified attorney (required before adoption)', status: MANUAL_DEFAULT },
    ],
  };
}
