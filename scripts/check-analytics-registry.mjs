#!/usr/bin/env node
// Fails CI when analytics drifts from the registry (src/lib/analyticsEvents.ts):
//   - a trackEvent()/trackRegisteredEvent() call uses an unregistered event or property, or a PII-looking property
//   - the registry itself is invalid (names, owners, PII flags)
//   - docs/analytics/tracking-plan.md does not list exactly the registered events
// Run: npm run lint:analytics
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { eventsInPlan, scanAnalyticsCalls } from './lib/analyticsScan.mjs';

const root = new URL('..', import.meta.url).pathname;

// Load the TypeScript registry on any Node version (no --experimental-strip-types needed).
const src = readFileSync(join(root, 'src/lib/analyticsEvents.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const { EVENT_REGISTRY, PII_PROPERTY_NAME_RE, validateRegistry } = mod;

const errors = [...validateRegistry(EVENT_REGISTRY)];
const scan = scanAnalyticsCalls({ root, registry: EVENT_REGISTRY, piiNameRe: PII_PROPERTY_NAME_RE });
errors.push(...scan.errors);

const plan = eventsInPlan(readFileSync(join(root, 'docs/analytics/tracking-plan.md'), 'utf8'));
for (const name of Object.keys(EVENT_REGISTRY)) if (!plan.has(name)) errors.push(`docs/analytics/tracking-plan.md: missing registered event "${name}"`);
for (const name of plan) if (!(name in EVENT_REGISTRY)) errors.push(`docs/analytics/tracking-plan.md: lists "${name}" which is not registered`);

if (errors.length) {
  console.error(`Analytics registry check failed (${errors.length}):\n - ${errors.join('\n - ')}`);
  process.exit(1);
}
console.log(`Analytics registry OK: ${Object.keys(EVENT_REGISTRY).length} events, ${scan.callCount} call sites checked.`);
