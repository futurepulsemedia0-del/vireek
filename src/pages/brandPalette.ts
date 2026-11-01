import { BRAND_COLORS } from '@/styles/tokens.generated';

export interface ColorToken {
  name: string;
  lightHex: string;
  darkHex?: string;
  usage: string;
}

// Official palette — read from the GENERATED token file (scripts/color/palette.mjs → npm run tokens:build),
// so this page can never drift from the product. Every pairing below is verified in CI (≥ 4.5:1 text, ≥ 3:1 UI).
const bc = BRAND_COLORS;
const tok = (name: string, usage: string, key: keyof typeof bc.light): ColorToken => ({ name, lightHex: bc.light[key], darkHex: bc.dark[key], usage });

export const ACCENT_COLORS: ColorToken[] = [
  tok('Accent fill', 'Buttons and solid surfaces — always pair with On-accent', 'accent-fill'),
  tok('On-accent', 'Text and icons on the accent fill (7.9:1 light, 4.8:1 dark)', 'on-accent'),
  tok('Accent text', 'Links and accent-coloured text (≥ 4.5:1 on every surface)', 'accent-text'),
  tok('Accent subtle', 'Tinted backgrounds, badges, selected rows', 'accent-subtle'),
  tok('Accent strong', 'Text on the subtle tint (≥ 7:1)', 'accent-strong'),
];

export const CTA_COLORS: ColorToken[] = [
  tok('Copper fill', 'Live/urgent solid surfaces (active call, emergency) — never a generic CTA', 'cta-fill'),
  tok('On-copper', 'Text on the copper fill', 'on-cta'),
  tok('Copper text', 'Darker copper for text (≥ 4.5:1)', 'cta-text'),
  tok('Copper graphic', 'Icons, dots and large shapes (≥ 3:1)', 'cta-graphic'),
];

export const SEMANTIC_COLORS: ColorToken[] = [
  tok('Success text', 'Confirmations, positive states', 'success-text'),
  tok('Danger text', 'Errors, destructive actions', 'danger-text'),
  tok('Warning text', 'Caution states', 'warning-text'),
  tok('Info text', 'Neutral information (new)', 'info-text'),
  tok('Success subtle', 'Tinted background for success', 'success-subtle'),
  tok('Danger subtle', 'Tinted background for errors', 'danger-subtle'),
];

export const NEUTRAL_COLORS: ColorToken[] = [
  tok('Background primary', 'Page background', 'bg-primary'),
  tok('Background secondary', 'Cards, panels', 'bg-secondary'),
  tok('Background tertiary', 'Wells, table stripes', 'bg-tertiary'),
  tok('Text primary', 'Headings, body copy (≥ 7:1)', 'text-primary'),
  tok('Text secondary', 'Supporting copy', 'text-secondary'),
  tok('Text muted', 'Captions, placeholders (still ≥ 4.5:1)', 'text-muted'),
  tok('Border — subtle', 'Decorative dividers and card edges only', 'border-default'),
  tok('Border — strong', 'Inputs, checkboxes, switches: ≥ 3:1 (WCAG 1.4.11)', 'border-strong'),
];

export const COLOR_DOS: string[] = [
  'Use semantic classes: bg-accent + text-on-accent, text-text-secondary, border-border-strong, bg-success-subtle + text-success-strong.',
  'Pair every solid fill with its on-* colour — never choose text colour by eye.',
  'Reserve copper for live / urgent moments (active call, emergency detection).',
  'Pair status colour with an icon or label; underline links inside text; give chart series a pattern, marker and direct label.',
];
export const COLOR_DONTS: string[] = [
  'No hex / rgb() / raw Tailwind palette classes (blue-500, gray-600 …) — CI fails the build.',
  'Never put muted text over the gradient mesh or an image without a surface behind it.',
  'Never use copper as a decorative or generic call-to-action colour.',
  'Never rely on colour alone to show status, errors, required fields or chart series.',
];
