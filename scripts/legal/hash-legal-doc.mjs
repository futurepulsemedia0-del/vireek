#!/usr/bin/env node
// Prints the SHA-256 recorded as content_sha256 when publishing a legal document version.
// Usage: node scripts/legal/hash-legal-doc.mjs <file>   (the exact published text, UTF-8)
// Normalisation (so the same text always gives the same hash): strip BOM, CRLF/CR -> LF, trim trailing whitespace per
// line, trim the end of the file, end with one LF. Keep the file you hashed with the release as evidence. [COUNSEL]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function normalizeLegalText(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').replace(/\s+$/, '') + '\n';
}
export function legalSha256(text) {
  return createHash('sha256').update(normalizeLegalText(text), 'utf8').digest('hex');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/legal/hash-legal-doc.mjs <file>');
    process.exit(2);
  }
  console.log(legalSha256(readFileSync(file, 'utf8')));
}
