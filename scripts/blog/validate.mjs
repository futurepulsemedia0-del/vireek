#!/usr/bin/env node
// npm run blog:validate [-- --strict]
// Validates every article against the schema and the cross-post rules. Exits 1 on any error
// (use it in CI). --strict also fails on warnings (placeholder authors, missing FAQ, short posts…).
import process from 'node:process';
import { ROOT, collectRoutes } from '../seo/routes.mjs';
import { loadBlog } from './pipeline.mjs';

const strict = process.argv.includes('--strict');
const routes = await collectRoutes(); // real route list -> verifies non-blog internal links
const knownPaths = new Set(routes.filter((r) => r.kind !== 'blog').map((r) => r.path));
const { posts, categories, errors, warnings } = loadBlog({ root: ROOT, knownPaths });

for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`error:   ${e}`);
console.log(`\n[blog] ${posts.length} published post(s), ${categories.length} categories, ${errors.length} error(s), ${warnings.length} warning(s).`);
if (errors.length || (strict && warnings.length)) process.exit(1);
