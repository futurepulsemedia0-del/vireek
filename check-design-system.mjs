#!/usr/bin/env node
// scripts/check-design-system.mjs
//
// Enforces the 5 design-system rules from the Vireek UX audit by scanning
// the ACTUAL current codebase — not a snapshot — so it stays accurate no
// matter how many more edits (human or AI) land after this script is
// added. Run it locally with `npm run lint:design`; CI runs it on every
// push/PR via .github/workflows/ci.yml and fails the build on violations.
//
// Each rule below prints every offending file:line so you can jump
// straight to it in VS Code (Ctrl+click the path in the terminal, or
// Ctrl+G to the line number) and swap in the shared component.
//
// Deliberately plain Node + regex over the raw file text, not an ESLint
// AST plugin: these are string-literal / import-presence checks, which
// regex handles perfectly well and keeps this script readable and
// tweakable by hand as new rules are needed — no ESLint plugin API to
// learn.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');

/** @type {{ rule: string, file: string, line: number, snippet: string }[]} */
const violations = [];

function walk(dir, onFile) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === 'ui') continue; // ui/ = the primitives themselves
      walk(full, onFile);
    } else if (extname(entry) === '.tsx' || extname(entry) === '.ts') {
      onFile(full);
    }
  }
}

function scanLines(filePath, pattern, rule) {
  const rel = relative(ROOT, filePath);
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (pattern.test(line)) {
      violations.push({ rule, file: rel, line: i + 1, snippet: line.trim().slice(0, 100) });
    }
    pattern.lastIndex = 0; // reset global regex state between lines
  });
}

// ------------------------------------------------------------------
// Rule 1 — no local `inputClass` reinventions. Everyone imports <Input>
// (or <Textarea>) from '@/components/ui/Input' instead.
// ------------------------------------------------------------------
const RULE_INPUT = /^\s*const\s+inputClass\s*=/;

// ------------------------------------------------------------------
// Rule 2 — no hand-copied <Card> recipe. If you need a card, import
// <Card> from '@/components/ui/Card'.
// ------------------------------------------------------------------
const RULE_CARD = /rounded-2xl border border-border bg-bg-secondary p-[68] shadow-card/;

// ------------------------------------------------------------------
// Rule 3 — no hand-copied primary-button recipe. Import <Button
// variant="primary"> from '@/components/ui/Button'.
// ------------------------------------------------------------------
const RULE_BUTTON = /rounded-xl bg-(cta|accent) px-\d/;

// ------------------------------------------------------------------
// Rule 4 — a page that imports Loader2 for a full-view loading state
// should use the Skeleton family instead (Loader2 is still fine
// *inside* a button's own submitting state — this rule only flags
// files that use Loader2 but never import Skeleton at all, since that
// combination usually means the whole view renders a bare spinner
// instead of a content-shaped skeleton).
// ------------------------------------------------------------------
function checkLoadingStandard(filePath) {
  const rel = relative(ROOT, filePath);
  const text = readFileSync(filePath, 'utf8');
  const usesLoader2AsPageLoader = /<Loader2[^>]*size=\{?(2[4-9]|[3-9]\d)/.test(text); // size >=24 ~= page-level, not inline-in-button
  const importsSkeleton = /from ['"]@\/components\/Skeleton['"]/.test(text);
  if (usesLoader2AsPageLoader && !importsSkeleton) {
    const lineIdx = text.split('\n').findIndex((l) => /<Loader2[^>]*size=\{?(2[4-9]|[3-9]\d)/.test(l));
    violations.push({
      rule: 'loading-standard',
      file: rel,
      line: lineIdx + 1,
      snippet: 'Large <Loader2> with no Skeleton import — likely a bare full-page spinner instead of a content skeleton.',
    });
  }
}

// ------------------------------------------------------------------
// Rule 5 — "No X found/yet" copy should live inside <EmptyState>, not
// as bare hand-written JSX text.
// ------------------------------------------------------------------
function checkEmptyStateStandard(filePath) {
  const rel = relative(ROOT, filePath);
  const text = readFileSync(filePath, 'utf8');
  const hasBareEmptyCopy = />\s*No [^<]{2,40}(found|yet)\.?\s*</i.test(text);
  const importsEmptyState = /from ['"]@\/components\/EmptyState['"]/.test(text);
  if (hasBareEmptyCopy && !importsEmptyState) {
    const lineIdx = text.split('\n').findIndex((l) => />\s*No [^<]{2,40}(found|yet)\.?\s*</i.test(l));
    violations.push({
      rule: 'empty-state-standard',
      file: rel,
      line: lineIdx + 1,
      snippet: text.split('\n')[lineIdx]?.trim().slice(0, 100) ?? '',
    });
  }
}

walk(SRC, (file) => {
  // The primitives are allowed to contain their own reference recipe.
  if (file.endsWith(join('ui', 'Button.tsx')) || file.endsWith(join('ui', 'Card.tsx')) || file.endsWith(join('ui', 'Input.tsx'))) {
    return;
  }
  scanLines(file, RULE_INPUT, 'no-local-input-class');
  scanLines(file, RULE_CARD, 'no-handrolled-card');
  scanLines(file, RULE_BUTTON, 'no-handrolled-button');
  checkLoadingStandard(file);
  checkEmptyStateStandard(file);
});

if (violations.length === 0) {
  console.log('✔ Design-system check passed — no drift detected.');
  process.exit(0);
}

console.error(`✘ Design-system check found ${violations.length} violation(s):\n`);
const byRule = violations.reduce((acc, v) => {
  (acc[v.rule] ??= []).push(v);
  return acc;
}, /** @type {Record<string, typeof violations>} */ ({}));

const RULE_TITLES = {
  'no-local-input-class': 'Rule 1 — Use <Input>/<Textarea> from @/components/ui/Input instead of a local inputClass',
  'no-handrolled-card': 'Rule 2 — Use <Card> from @/components/ui/Card instead of copying its className',
  'no-handrolled-button': 'Rule 3 — Use <Button variant="primary"> from @/components/ui/Button instead of copying its className',
  'loading-standard': 'Rule 4 — Use the Skeleton family from @/components/Skeleton for full-view loading states',
  'empty-state-standard': 'Rule 5 — Use <EmptyState> from @/components/EmptyState instead of bare "No X found/yet" text',
};

for (const [rule, items] of Object.entries(byRule)) {
  console.error(`\n${RULE_TITLES[rule] ?? rule} (${items.length}):`);
  for (const v of items) {
    console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
  }
}

console.error('\nFix each line above, then re-run: npm run lint:design\n');
process.exit(1);
