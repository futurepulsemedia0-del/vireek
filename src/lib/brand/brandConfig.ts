// src/lib/brand/brandConfig.ts
//
// Single source of truth for every Vireek brand string: footer, emails, meta tags, social bios,
// OG cards, PWA manifest checks. React-free and erasable-TS only, so build scripts can load it via
// esbuild (scripts/seo/routes.mjs -> loadTsModule) and Node can run it directly.

export const BRAND = {
  /** Always "Vireek": capital V, rest lowercase. Never VIREEK / vireek / ViReek in prose. */
  name: 'Vireek',
  domain: 'vireek.com',
  siteUrl: 'https://vireek.com',
  /** Receptionist persona. Always "Sarah", always disclosed as AI (see brandFacts.ts). */
  persona: 'Sarah',
  /** Short tagline (lockup line). */
  tagline: 'Never miss a call.',
  /** What Vireek is, in one phrase. */
  descriptor: 'AI voice receptionist for home services',
  /** One-sentence description reused by bios, press kit and meta fallbacks. */
  description:
    'Vireek is an AI voice receptionist built for home service businesses. Answer calls, capture leads, book appointments, and keep customer communication moving 24/7.',
  /**
   * Trademark: Vireek is used with TM. Never use the registered mark symbol until a registration
   * is granted AND this flag is flipped (it is a legal claim, not a styling choice).
   */
  registered: false,
  colors: {
    light: { bg: '#FDFCFA', text: '#17171A', muted: '#676770', accent: '#203AD8', live: '#D6582A' },
    dark: { bg: '#090A0D', text: '#F2F1EE', muted: '#9A9AA3', accent: '#6C82FF', live: '#FF8A5A' },
    accent500: '#3448E8',
    accent300: '#8FA0FB',
  },
} as const;

/** Browser chrome / PWA colors. Manifest cannot be scheme-aware, so it uses the light value. */
export const THEME_COLORS = { light: BRAND.colors.light.bg, dark: BRAND.colors.dark.bg } as const;

/** "Vireek" or "Vireek(TM)" depending on first-use rules. */
export function brandMark(withMark = false): string {
  if (!withMark) return BRAND.name;
  return `${BRAND.name}${BRAND.registered ? '\u00AE' : '\u2122'}`;
}

export function copyrightLine(year: number = new Date().getFullYear()): string {
  return `\u00A9 ${year} ${BRAND.name}. All rights reserved.`;
}

/** "Sarah, Vireek's AI receptionist" - persona is never presented without the AI qualifier. */
export const PERSONA_LINE = `${BRAND.persona}, ${BRAND.name}\u2019s AI receptionist`;

/** Tab/window title for app surfaces: "Jobs \u00B7 Vireek". Empty label -> just the brand. */
export function pageTitle(label?: string | null): string {
  const clean = (label ?? '').replace(/\s+/g, ' ').trim();
  return clean ? `${clean} \u00B7 ${BRAND.name}` : BRAND.name;
}

/** Removes a trailing " | Vireek ...", " - Vireek", " \u00B7 Vireek" segment (cards show the brand separately). */
export function stripBrandSuffix(title: string): string {
  return title
    .replace(/\s*[|\u00B7\u2013\u2014-]\s*Vireek\b[^|]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------------------------
// Open Graph card routing
// ---------------------------------------------------------------------------------------------

export const DEFAULT_OG_PATH = '/og-image.png';
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
const OG_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/**
 * Deterministic card file for a public path: "/" -> /og/home.png, "/blog/my-post" -> /og/blog--my-post.png.
 * Public slugs never contain "--", so "/" -> "--" cannot collide. Returns null for anything that is
 * not a clean public path (callers then use the default card).
 */
export function ogPathFor(pathname: string): string | null {
  const clean = pathname.split(/[?#]/)[0].replace(/\/+$/, '');
  const slug = clean === '' ? 'home' : clean.replace(/^\//, '').replace(/\//g, '--');
  return OG_SLUG_RE.test(slug) ? `/og/${slug}.png` : null;
}

/** Absolute og:image URL for a canonical URL. Foreign hosts and odd paths get the default card. */
export function ogUrlFor(canonicalOrPath: string): string {
  let pathname = canonicalOrPath;
  if (/^https?:\/\//i.test(canonicalOrPath)) {
    try {
      const u = new URL(canonicalOrPath);
      if (u.host !== BRAND.domain && u.host !== `www.${BRAND.domain}`) return `${BRAND.siteUrl}${DEFAULT_OG_PATH}`;
      pathname = u.pathname;
    } catch {
      return `${BRAND.siteUrl}${DEFAULT_OG_PATH}`;
    }
  }
  return `${BRAND.siteUrl}${ogPathFor(pathname) ?? DEFAULT_OG_PATH}`;
}

export type OgKind =
  | 'home' | 'pricing' | 'industry' | 'blog' | 'case-study' | 'help' | 'changelog'
  | 'compare' | 'integration' | 'switch' | 'location' | 'legal' | 'page';

export const OG_KIND_LABEL: Record<OgKind, string> = {
  home: 'AI Voice Receptionist',
  pricing: 'Pricing',
  industry: 'Industries',
  blog: 'Blog',
  'case-study': 'Case study',
  help: 'Help Center',
  changelog: 'Changelog',
  compare: 'Compare',
  integration: 'Integrations',
  switch: 'Switch to Vireek',
  location: 'Local',
  legal: 'Legal',
  page: 'Vireek',
};

const LEGAL_PATHS = new Set([
  '/privacy', '/cookies', '/terms', '/dpa', '/subprocessors', '/refund-policy', '/sla',
  '/acceptable-use-policy', '/responsible-ai', '/trademark-policy', '/vulnerability-disclosure',
  '/ccpa', '/accessibility-statement', '/gdpr-dpa',
]);

export function ogKindFor(pathname: string): OgKind {
  const p = pathname.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (p === '/') return 'home';
  if (p === '/pricing') return 'pricing';
  if (p === '/industries' || p.startsWith('/industries/')) return 'industry';
  if (p === '/blog' || p.startsWith('/blog/')) return 'blog';
  if (p === '/case-studies' || p.startsWith('/case-studies/')) return 'case-study';
  if (p === '/help' || p.startsWith('/help/')) return 'help';
  if (p === '/changelog' || p === '/developers/changelog') return 'changelog';
  if (p === '/compare' || p.startsWith('/compare/')) return 'compare';
  if (p === '/integrations' || p.startsWith('/integrations/')) return 'integration';
  if (p === '/switch' || p.startsWith('/switch/')) return 'switch';
  if (p.startsWith('/locations/')) return 'location';
  if (LEGAL_PATHS.has(p)) return 'legal';
  return 'page';
}

// ---------------------------------------------------------------------------------------------
// Naming rules (rendered on /brand and enforced by brandConfig.test.ts)
// ---------------------------------------------------------------------------------------------

export const NAMING_RULES: { rule: string; do: string; dont: string }[] = [
  { rule: 'Capitalization', do: 'Vireek', dont: 'VIREEK, vireek, ViReek (except in URLs, handles and code)' },
  { rule: 'Persona', do: `${BRAND.persona}, ${BRAND.name}\u2019s AI receptionist`, dont: `${BRAND.persona} the human receptionist, or "${BRAND.persona}" without saying she is AI` },
  { rule: 'Tagline lockup', do: `${BRAND.name} \u2014 ${BRAND.tagline}`, dont: 'Changing the wording, stacking it differently, or adding exclamation marks' },
  { rule: 'Trademark', do: `${BRAND.name}\u2122 on first prominent use per page or document`, dont: 'Using \u00AE (no registration yet) or repeating \u2122 on every mention' },
  { rule: 'Copyright', do: copyrightLine(2026).replace('2026', '{year}'), dont: 'Hard-coding the year; always call copyrightLine()' },
  { rule: 'Possessive', do: `${BRAND.name}\u2019s`, dont: "Vireek's with a straight apostrophe in published copy" },
];

// ---------------------------------------------------------------------------------------------
// Brand kit file table (generated by scripts/brand/make-brand-assets.mjs into public/brand-kit/)
// ---------------------------------------------------------------------------------------------

export interface BrandKitFile {
  file: string;
  title: string;
  platform: string;
  w: number;
  h: number;
  /** icon = symbol only, banner = symbol + wordmark + tagline, backdrop = video-call background. */
  layout: 'icon' | 'banner' | 'backdrop';
  /** Opaque PNG (no alpha), required by the App Store. */
  opaque?: boolean;
}

export const BRAND_KIT_IMAGES: BrandKitFile[] = [
  { file: 'profile-400.png', title: 'Profile image', platform: 'LinkedIn / X / Facebook / G2 / Capterra', w: 400, h: 400, layout: 'icon' },
  { file: 'profile-1024.png', title: 'Profile image (large)', platform: 'YouTube / Google Business', w: 1024, h: 1024, layout: 'icon' },
  { file: 'linkedin-banner-1584x396.png', title: 'LinkedIn banner', platform: 'LinkedIn', w: 1584, h: 396, layout: 'banner' },
  { file: 'linkedin-company-cover-1128x191.png', title: 'LinkedIn company page cover', platform: 'LinkedIn', w: 1128, h: 191, layout: 'banner' },
  { file: 'x-header-1500x500.png', title: 'X header', platform: 'X', w: 1500, h: 500, layout: 'banner' },
  { file: 'facebook-cover-1640x624.png', title: 'Facebook cover', platform: 'Facebook', w: 1640, h: 624, layout: 'banner' },
  { file: 'youtube-banner-2560x1440.png', title: 'YouTube banner', platform: 'YouTube', w: 2560, h: 1440, layout: 'banner' },
  { file: 'google-business-cover-1080x608.png', title: 'Google Business cover', platform: 'Google Business Profile', w: 1080, h: 608, layout: 'banner' },
  { file: 'slack-discord-icon-512.png', title: 'Slack / Discord app icon', platform: 'Slack / Discord', w: 512, h: 512, layout: 'icon' },
  { file: 'app-store-icon-1024.png', title: 'App Store icon', platform: 'Apple App Store', w: 1024, h: 1024, layout: 'icon', opaque: true },
  { file: 'google-play-icon-512.png', title: 'Google Play icon', platform: 'Google Play', w: 512, h: 512, layout: 'icon' },
  { file: 'google-play-feature-1024x500.png', title: 'Google Play feature graphic', platform: 'Google Play', w: 1024, h: 500, layout: 'banner' },
  { file: 'video-background-1920x1080.png', title: 'Zoom / Teams background', platform: 'Zoom / Microsoft Teams', w: 1920, h: 1080, layout: 'backdrop' },
  { file: 'email-signature-logo-240x240.png', title: 'Email signature logo', platform: 'Email', w: 240, h: 240, layout: 'icon' },
];

export const BRAND_KIT_TEXT_FILES = [
  { file: 'bios.txt', title: 'Bios (short / medium / long)', platform: 'All profiles' },
  { file: 'link-in-bio.txt', title: 'Link-in-bio copy', platform: 'Instagram / TikTok / X' },
  { file: 'email-signature.html', title: 'Email signature (HTML)', platform: 'Email' },
  { file: 'press-boilerplate.txt', title: 'Press boilerplate', platform: 'Press' },
  { file: 'CHECKLIST.md', title: 'Off-site profile checklist', platform: 'All' },
] as const;

/** Shape consumed by BrandGuidelinesPage's DOWNLOAD_ASSETS cards. */
export const BRAND_KIT_DOWNLOADS = [
  ...BRAND_KIT_IMAGES.map((f) => ({
    title: f.title,
    description: f.platform,
    href: `/brand-kit/${f.file}`,
    meta: `PNG \u00B7 ${f.w}\u00D7${f.h}`,
  })),
  ...BRAND_KIT_TEXT_FILES.map((f) => ({
    title: f.title,
    description: f.platform,
    href: `/brand-kit/${f.file}`,
    meta: f.file.split('.').pop()!.toUpperCase(),
  })),
];

export function bioShort(): string {
  return `${BRAND.name}: ${BRAND.descriptor}. ${BRAND.tagline}`;
}

export function pressBoilerplate(): string {
  return `About ${BRAND.name}\n\n${BRAND.description} Its receptionist, ${PERSONA_LINE}, picks up every call, qualifies the lead, flags emergencies and books the job. ${BRAND.name} is an early-stage, founder-led company. Learn more at ${BRAND.siteUrl}.\n\n${copyrightLine()} ${BRAND.name}\u2122 is a trademark of ${BRAND.name}.`;
}
