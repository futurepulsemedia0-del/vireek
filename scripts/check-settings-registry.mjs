#!/usr/bin/env node
// Fails CI when a /dashboard/settings/* route in src/App.tsx is missing from the settings registry,
// when a registry route does not exist in App.tsx, or when the registry is invalid.
// Run: npm run lint:settings  (Node >= 22.6 for --experimental-strip-types, handled below)
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');
const { SETTINGS_REGISTRY, validateRegistry, SETTINGS_HUB_ROUTE } = await import(
  pathToFileURL(join(root, 'src/lib/settings/registry.ts')).href
);

const appRoutes = new Set([...app.matchAll(/path=["'](\/dashboard\/[^"']+)["']/g)].map((m) => m[1]));
const settingsRoutes = [...appRoutes].filter((r) => r.startsWith('/dashboard/settings/'));
const registered = new Set(SETTINGS_REGISTRY.map((x) => x.route));
const errors = validateRegistry();

for (const r of settingsRoutes) if (!registered.has(r)) errors.push(`route not in registry: ${r}`);
for (const r of registered) if (!appRoutes.has(r)) errors.push(`registry route missing from App.tsx: ${r}`);
if (!appRoutes.has(SETTINGS_HUB_ROUTE)) errors.push('hub route missing from App.tsx');

if (errors.length) {
  console.error(`Settings registry check failed (${errors.length}):\n - ${errors.join('\n - ')}`);
  process.exit(1);
}
console.log(`Settings registry OK: ${registered.size} entries, ${settingsRoutes.length} settings routes covered.`);
