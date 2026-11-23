#!/usr/bin/env node
// Regenerates .github/CODEOWNERS and docs/governance/service-ownership.md from docs/governance/ownership-map.json.
import { writeFileSync } from 'node:fs';
import { CODEOWNERS_FILE, DOC_FILE, loadMap, renderCodeowners, renderDoc, validateMap } from './ownership-lib.mjs';

const map = loadMap();
const problems = validateMap(map);
if (problems.length) {
  for (const p of problems) console.error(`error: ${p}`);
  process.exit(1);
}
writeFileSync(CODEOWNERS_FILE, renderCodeowners(map));
writeFileSync(DOC_FILE, renderDoc(map));
console.log(`wrote ${CODEOWNERS_FILE} and ${DOC_FILE}`);
