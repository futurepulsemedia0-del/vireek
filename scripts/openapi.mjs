#!/usr/bin/env node
/**
 * OpenAPI publisher + drift check for the public api-v1 edge function.
 *
 *   node scripts/openapi.mjs generate   write public/openapi.json
 *   node scripts/openapi.mjs check      exit 1 when the function, the contract and
 *                                       the published spec disagree (used in CI)
 *
 * Source of truth: supabase/functions/api-v1/contract.ts
 * Works without `npm ci` on Node >= 22.18 (native TypeScript); on older Node it
 * transparently loads the contract through Vite (a devDependency) instead.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = resolve(ROOT, 'supabase/functions/api-v1/contract.ts');
const FUNCTION_SRC = resolve(ROOT, 'supabase/functions/api-v1/index.ts');
const PUBLISHED = resolve(ROOT, 'public/openapi.json');
const REL = (p) => p.slice(ROOT.length + 1).replaceAll('\\', '/');

// Public base URL baked into the published spec (the Vireek production Supabase project).
// Change this one line if the API is ever served from another host (e.g. api.vireek.com).
const PUBLISHED_SERVER_URL = 'https://tagpfcwwxnmsmjneciqh.supabase.co/functions/v1/api-v1';

const onGithub = process.env.GITHUB_ACTIONS === 'true';
const fail = (file, message) => {
  if (onGithub) console.log(`::error file=${REL(file)},title=OpenAPI drift::${message.replaceAll('\n', ' ')}`);
  console.error(`✖ ${message}`);
};

async function loadContract() {
  try {
    return await import(pathToFileURL(CONTRACT).href);
  } catch (err) {
    if (err?.code !== 'ERR_UNKNOWN_FILE_EXTENSION' && err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  }
  // Node without native TypeScript: let Vite transpile the (import-free) contract.
  const { createServer } = await import('vite');
  const server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  try {
    return await server.ssrLoadModule('/supabase/functions/api-v1/contract.ts');
  } finally {
    await server.close();
  }
}

/** "GET /calls/{id}" for every operation in a spec object. */
function routesOf(spec) {
  return Object.entries(spec?.paths ?? {}).flatMap(([path, methods]) =>
    Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
  );
}

async function main() {
  const mode = process.argv[2];
  if (mode !== 'generate' && mode !== 'check') {
    console.error('Usage: node scripts/openapi.mjs <generate|check>');
    process.exit(2);
  }

  const contract = await loadContract();
  const spec = contract.buildOpenApiSpec(PUBLISHED_SERVER_URL);
  const generated = contract.serializeSpec(spec);

  const problems = contract.validateSpec(spec);
  if (problems.length) {
    problems.forEach((p) => fail(CONTRACT, `Generated spec is invalid: ${p}`));
    process.exit(1);
  }

  if (mode === 'generate') {
    mkdirSync(dirname(PUBLISHED), { recursive: true });
    writeFileSync(PUBLISHED, generated);
    console.log(`✔ Wrote ${REL(PUBLISHED)} — OpenAPI ${spec.openapi}, ${routesOf(spec).length} operations`);
    return;
  }

  let failed = false;

  // 1) The edge function must route through the contract (no hidden routes/rules).
  for (const p of contract.checkEdgeFunctionSource(readFileSync(FUNCTION_SRC, 'utf8'))) {
    fail(FUNCTION_SRC, p);
    failed = true;
  }

  // 2) The published spec must equal what the contract generates.
  if (!existsSync(PUBLISHED)) {
    fail(PUBLISHED, `${REL(PUBLISHED)} is missing. Run: npm run openapi:generate`);
    failed = true;
  } else {
    const published = readFileSync(PUBLISHED, 'utf8');
    if (published !== generated) {
      let publishedSpec = null;
      try {
        publishedSpec = JSON.parse(published);
      } catch {
        /* handled below */
      }
      const want = new Set(routesOf(spec));
      const have = new Set(routesOf(publishedSpec));
      const missing = [...want].filter((r) => !have.has(r));
      const extra = [...have].filter((r) => !want.has(r));
      const detail = [
        missing.length ? `routes missing from the published spec: ${missing.join(', ')}` : '',
        extra.length ? `routes in the published spec that the API no longer has: ${extra.join(', ')}` : '',
        !missing.length && !extra.length ? 'routes match, but schemas / parameters / responses / metadata differ' : '',
      ]
        .filter(Boolean)
        .join('; ');
      fail(PUBLISHED, `${REL(PUBLISHED)} is out of date (${detail}). Run: npm run openapi:generate and commit the result.`);
      failed = true;
    }
  }

  if (failed) process.exit(1);
  console.log(`✔ OpenAPI in sync: ${routesOf(spec).length} operations, function routed via contract.ts, ${REL(PUBLISHED)} up to date`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
