#!/usr/bin/env node
// Build-time guard for the SPA shell. A missing <style> opener (or any stray text) inside <head> makes browsers
// close <head> early, which silently moves <title>, canonical, Open Graph and JSON-LD into <body>.
// Run: node scripts/seo/lint-index-html.mjs [path/to/index.html]   (wired into `npm run build`)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const count = (s, re) => (s.match(re) ?? []).length;

/** Pure: returns a list of human-readable problems (empty = OK). */
export function lintIndexHtml(html) {
  const problems = [];
  const headStart = html.search(/<head\b[^>]*>/i);
  const headEnd = html.indexOf('</head>');
  if (headStart === -1 || headEnd === -1 || headEnd < headStart) return ['missing <head> or </head>'];

  const head = html.slice(headStart, headEnd);
  const opens = count(head, /<style\b/gi);
  const closes = count(head, /<\/style>/gi);
  if (opens !== closes) problems.push(`<style> tags unbalanced in <head> (${opens} opening vs ${closes} closing)`);

  // Remove everything that legitimately holds text, then no visible text may remain.
  const residue = head
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|title)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  if (residue) problems.push(`stray text inside <head> (browsers will close <head> here): "${residue.slice(0, 60)}"`);

  if (count(head, /<title\b/gi) !== 1) problems.push('<head> must contain exactly one <title>');
  if (count(head, /<link\b[^>]*\brel="canonical"/gi) !== 1) problems.push('<head> must contain exactly one canonical link');
  if (count(head, /<meta\b[^>]*\bname="description"/gi) !== 1) problems.push('<head> must contain exactly one meta description');
  for (const m of head.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      JSON.parse(m[1]);
    } catch (e) {
      problems.push(`invalid JSON-LD in <head>: ${String(e.message).slice(0, 80)}`);
    }
  }
  if (count(html, /<\/head>/gi) !== 1) problems.push('more than one </head>');
  return problems;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const file = process.argv[2] ?? path.join(root, 'index.html');
  const problems = lintIndexHtml(readFileSync(file, 'utf8'));
  if (problems.length) {
    for (const p of problems) console.error(`[index-lint] ${p}`);
    process.exit(1);
  }
  console.log(`[index-lint] OK - ${path.relative(root, file) || file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
