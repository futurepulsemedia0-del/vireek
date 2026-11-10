// scripts/brand-audit/config.mjs
//
// Single source of truth for the brand audit: categories, weights, floors, viewports and the
// reviewed exemption lists. Change thresholds here (in a PR that BRAND_GOVERNANCE.md says needs
// design + eng review), never inline in a check.

/** Weights sum to 100. `floor` = hard CI gate (null = no gate until a baseline exists). `target` = goal shown in the report. */
export const CATEGORIES = [
  { id: 'visual',        label: 'Visual identity consistency',          weight: 8,  floor: null, target: 90 },
  { id: 'tokens',        label: 'Design-token compliance',              weight: 10, floor: null, target: 95 },
  { id: 'states',        label: 'UX state coverage',                    weight: 10, floor: null, target: 90 },
  { id: 'a11y',          label: 'Accessibility',                        weight: 12, floor: null, target: 95 },
  { id: 'performance',   label: 'Performance (CWV + bundle budgets)',   weight: 10, floor: null, target: 85 },
  { id: 'seo',           label: 'SEO and metadata completeness',        weight: 7,  floor: null, target: 95 },
  { id: 'l10n',          label: 'Copy/voice + localization (incl. RTL)', weight: 10, floor: null, target: 90 },
  { id: 'trust',         label: 'Trust and claims accuracy',            weight: 6,  floor: null, target: 90 },
  { id: 'documents',     label: 'Email / PDF / document branding',      weight: 6,  floor: null, target: 90 },
  { id: 'mobile',        label: 'Mobile app polish',                    weight: 6,  floor: null, target: 90 },
  { id: 'devdocs',       label: 'Developer docs quality',               weight: 4,  floor: null, target: 90 },
  { id: 'security',      label: 'Security headers + privacy UX',        weight: 8,  floor: null, target: 95 },
  { id: 'naming',        label: 'Brand naming / trademark usage',       weight: 3,  floor: null, target: 95 },
];

/** Max score drop (points) vs the previous run before a category counts as a regression and fails the gate. */
export const REGRESSION_TOLERANCE = 2;

export const THEMES = ['light', 'dark'];
export const VIEWPORTS = [
  { name: '375', width: 375, height: 812 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 800 },
];

/** localStorage keys the app reads (verified in src/contexts/ThemeContext.tsx and src/lib/languageSync.ts). */
export const THEME_STORAGE_KEY = 'vireek-theme';
export const LANG_STORAGE_KEY = 'vireek-a11y-lang';
export const RTL_LANGS = ['ar', 'fa'];

/** Routes that get the full theme x viewport matrix + CWV. Others get the light pass (1280 light only). 30+ routes. */
export const KEY_ROUTES = {
  public: [
    '/', '/pricing', '/features', '/platform', '/industries', '/integrations', '/security', '/trust',
    '/faq', '/about', '/contact', '/demo', '/blog', '/compare', '/case-studies', '/enterprise',
    '/privacy', '/terms', '/accessibility-statement', '/status', '/login', '/signup',
  ],
  // Authenticated routes (need E2E_TEST_EMAIL / E2E_TEST_PASSWORD). Missing routes are reported, not failed.
  auth: [
    '/dashboard', '/dashboard/calls', '/dashboard/dispatch', '/dashboard/billing', '/dashboard/analytics',
    '/dashboard/calendar', '/dashboard/customers', '/dashboard/jobs', '/dashboard/inbox', '/dashboard/settings',
    '/dashboard/usage',
  ],
};

/** Files that legitimately contain raw colors/px. Every entry needs a reason a reviewer can challenge. */
export const TOKEN_EXEMPT = [
  { prefix: 'src/components/brand/', reason: 'Logo/brand artwork is the source of the brand colors.' },
  { prefix: 'src/pages/dev/', reason: 'Internal galleries, not shipped to customers.' },
  { prefix: 'src/pages/TokensPreview.tsx', reason: 'Documents the token palette by displaying raw values.' },
  { prefix: 'src/pages/BrandGuidelinesPage.tsx', reason: 'Public brand page that publishes the palette values.' },
  { prefix: 'src/lib/documentTemplates.ts', reason: 'Tenant-selected document colors.' },
  { prefix: 'src/components/documentTemplates/', reason: 'Tenant-selected document colors (designer UI).' },
  { prefix: 'src/lib/branding.ts', reason: 'Tenant brand defaults (white label).' },
  { prefix: 'src/lib/whiteLabel.ts', reason: 'Tenant brand defaults (white label).' },
  { prefix: 'src/test/', reason: 'Test support.' },
];

/** Fonts allowed as the FIRST family of visible text (lower-cased). Source: tailwind.config.js + index.css. */
export const ALLOWED_FONTS = ['sora', 'source serif 4', 'georgia', 'times new roman', 'inter', 'ui-sans-serif', 'system-ui', 'ui-monospace', 'sfmono-regular', 'menlo', 'monaco', 'consolas', 'courier new', 'monospace', '-apple-system', 'blinkmacsystemfont', 'segoe ui'];

/** Canonical brand naming (see /trademark-policy). */
export const NAMING = {
  canonicalName: 'Vireek',
  canonicalDomain: 'vireek.com',
  /** Sub-brands that exist in the product (capacitor.config.ts). */
  productNames: ['Vireek Field', 'Vireek Home', 'Vireek AI Core', 'Vireek Pulse'],
  /** Non-canonical domains/handles that were reviewed and are intentional. */
  allowedOtherDomains: ['instagram.com/vireek.ai'],
};

/** Pages a trust-minded buyer expects. Checked against the route table + sitemap list. */
export const TRUST_SURFACE = [
  '/trust', '/security', '/privacy', '/terms', '/dpa', '/subprocessors', '/sla', '/status',
  '/responsible-ai', '/accessibility-statement', '/vulnerability-disclosure', '/trademark-policy', '/cookies',
];

/** Things automation cannot prove. Reported separately and NEVER scored. */
export const NEEDS_EVIDENCE_STATIC = {
  visual:      [],
  tokens:      [],
  a11y:        ['Independent WCAG 2.2 AA audit / VPAT by a third party', 'Manual screen-reader pass (NVDA, JAWS, VoiceOver, TalkBack) on top flows', 'Testing with disabled users'],
  performance: ['Real-user monitoring (RUM) or CrUX field data — lab runs are directional only'],
  seo:         ['Google Search Console indexing/coverage data'],
  l10n:        ['Native-speaker review of every machine-drafted translation (ar, fa, hi, ja, zh first)'],
  trust:       ['Third-party certifications cited in copy (SOC 2 report, ISO 27001 certificate, HIPAA/PCI attestations)', 'Real customer references and written permission for every testimonial/case study', 'Real third-party reviews/ratings (G2, Capterra, app stores) behind any rating claim', 'Measured uptime history behind any availability number'],
  documents:   ['Rendering tests in real email clients (Gmail, Outlook, Apple Mail)', 'Live DKIM/SPF/DMARC DNS verification and deliverability data'],
  mobile:      ['Real-device testing (iOS + Android, notch/Dynamic Island, low-end hardware)', 'App Store / Play Store review outcome and real ratings'],
  devdocs:     ['Developer usability feedback (time-to-first-API-call with a real new developer)'],
  security:    ['Independent penetration test report', 'Live response-header verification on production (this audit reads vercel.json; staging/prod must be crawled with --base-url)'],
  naming:      ['Trademark registration status/search (USPTO, EUIPO, etc.) — legal evidence, not code'],
};

export const SEVERITY_WEIGHT = { critical: 10, high: 6, medium: 3, low: 1, info: 0 };
