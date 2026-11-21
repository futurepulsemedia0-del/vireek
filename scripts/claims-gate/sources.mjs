// scripts/claims-gate/sources.mjs
//
// WHICH files the claims gate reads. Kept apart from the detector so the scope is one reviewable list.
//
// Public copy        = pages routed on public URLs + marketing-only component folders + the data modules that feed
//                      public pages + blog posts (drafts included: they are the next public copy) + text the site
//                      publishes for crawlers/AI (llms*.txt, index.html).
// AI marketing output = golden/sample outputs stored under eval/marketing-outputs/ (put any AI-written marketing
//                      sample you want gated there) + the approved answers of the public site assistant
//                      (eval/site-assistant.manual.json, eval/site-assistant.generated.json).
// Not scanned (see docs/compliance/claims-gate.md): runtime text generated for a tenant, translations, i18n
// namespaces, components imported by public pages from other folders, anything behind /dashboard.

export const MARKETING_DIRS = [
  'src/components/sections', 'src/components/home', 'src/components/marketing', 'src/components/trust',
];
export const DATA_MODULES = [
  'homeContent', 'industries', 'competitors', 'integrations', 'switchGuides', 'alternatives', 'useCases',
  'resources', 'helpArticles', 'customerStories', 'brandFacts',
].map((n) => `src/lib/${n}.ts`);
export const PUBLIC_TEXT_FILES = ['public/llms.txt', 'public/llms-full.txt', 'index.html'];
export const BLOG_DIR = 'content/blog';
export const AI_OUTPUT_DIRS = ['eval/marketing-outputs'];
export const AI_OUTPUT_FILES = ['eval/site-assistant.manual.json', 'eval/site-assistant.generated.json'];

export const SCANNED_EXTS = ['.ts', '.tsx', '.md', '.txt', '.html', '.json'];
/** Never scanned, wherever they are found. */
export const SKIP = [
  /\.(test|spec|stories)\.[cm]?[jt]sx?$/, /\.built\.test\./, /(^|\/)__(tests|mocks)__\//, /(^|\/)dev\//,
  /(^|\/)README\.md$/, /(^|\/)_TEMPLATE\.md$/, /pages\/(TokensPreview|BrandGuidelinesPage)/,
  /src\/lib\/trust\/claims\.ts$/, // the wording registry itself states what NOT to say
];

/**
 * Component files of routes that are publicly reachable.
 * @param {{ appSrc: string, publicPaths: string[], resolve: (modulePath: string) => string|null }} o
 *   resolve("pages/PricingPage") -> "src/pages/PricingPage.tsx" or null when no such file exists
 * @returns {{ files: string[], unresolved: string[] }}
 */
export function discoverPublicPageFiles({ appSrc, publicPaths, resolve }) {
  const modules = new Map(); // component name -> module path under src/
  for (const m of appSrc.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*['"]@\/([^'"]+)['"]/g)) modules.set(m[1], m[2]);
  for (const m of appSrc.matchAll(/^import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\}\s*)?from\s+['"]@\/(pages\/[^'"]+|components\/[^'"]+)['"]/gm)) {
    if (m[1]) modules.set(m[1], m[3]);
    for (const part of (m[2] ?? '').split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) modules.set(name, m[3]);
    }
  }
  const routeComp = new Map(); // path -> component name
  for (const m of appSrc.matchAll(/<Route\s+path="([^"]+)"\s+element=\{<([A-Z]\w*)/g)) if (!routeComp.has(m[1])) routeComp.set(m[1], m[2]);

  const files = new Set();
  const unresolved = [];
  for (const p of publicPaths) {
    const comp = routeComp.get(p);
    const file = comp && modules.has(comp) ? resolve(modules.get(comp)) : null;
    if (file) files.add(file);
    else unresolved.push(p);
  }
  return { files: [...files].sort(), unresolved };
}
