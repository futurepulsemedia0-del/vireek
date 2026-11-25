import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  BASELINE_FILE,
  analyze,
  compare,
  extractImports,
  packageNameOf,
  parseNoSaveInstalls,
  readBaseline,
  writeBaseline,
} from './dependency-doctor.mjs';

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'depdoctor-'));
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(root, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const lockWith = (rootDeps, installed) => ({
  lockfileVersion: 3,
  packages: {
    '': { dependencies: rootDeps },
    ...Object.fromEntries(installed.map((n) => [`node_modules/${n}`, { version: '1.0.0' }])),
  },
});

test('packageNameOf: bare, scoped, subpath, and non-packages', () => {
  assert.equal(packageNameOf('react'), 'react');
  assert.equal(packageNameOf('react/jsx-runtime'), 'react');
  assert.equal(packageNameOf('@supabase/supabase-js'), '@supabase/supabase-js');
  assert.equal(packageNameOf('@capacitor/core/dist/x'), '@capacitor/core');
  for (const s of ['./a', '../a', '@/components/x', '#internal', 'node:fs', 'fs', 'virtual:vireek-blog', 'npm:zod', 'https://x.y/z', 'Label: value']) {
    assert.equal(packageNameOf(s), null, s);
  }
});

test('extractImports: static, type, side-effect, export-from, dynamic, require', () => {
  // Built from strings so this file's own source contains no line-leading import statements.
  const src = [
    "import a from 'alpha';",
    "import type { B } from 'beta';",
    "import 'gamma/side-effect';",
    'import { x,',
    "  y } from '@scope/delta';",
    "export * from 'epsilon';",
    'const z = await import(' + "'zeta');",
    'const q = require(' + "'eta');",
    "import local from './local';",
  ].join('\n');
  assert.deepEqual(
    [...extractImports(src)].sort(),
    ['@scope/delta', 'alpha', 'beta', 'epsilon', 'eta', 'gamma', 'zeta'],
  );
});

test('extractImports ignores prose and template-literal samples', () => {
  const src = [
    "const t = `node: import { Vireek } from '@vireek/sdk';`;",
    "const s = 'sign out others from the session';",
    'const msg = `${source} failed`;',
  ].join('\n');
  assert.equal(extractImports(src).size, 0);
});

test('parseNoSaveInstalls: continuations, versions, scoped names, flags', () => {
  const sh = `npm install --legacy-peer-deps
npm install --no-save --legacy-peer-deps --ignore-scripts \\
  zod@3 @hookform/resolvers@3 yaml \\
  @capacitor/core three@0.183.2
npx playwright install chromium`;
  assert.deepEqual(
    [...parseNoSaveInstalls(sh)].sort(),
    ['@capacitor/core', '@hookform/resolvers', 'three', 'yaml', 'zod'],
  );
});

test('analyze: a consistent project has no findings', () => {
  const root = fixture({
    'package.json': { name: 'app', dependencies: { react: '^18.0.0' }, devDependencies: { vitest: '^2.0.0' } },
    'package-lock.json': lockWith({ react: '^18.0.0', vitest: '^2.0.0' }, ['react', 'vitest']),
    'src/a.ts': "import React from 'react'; import { x } from './b';",
    'src/a.test.ts': "import { it } from 'vitest';",
  });
  try {
    assert.deepEqual(analyze(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyze: reports undeclared, lock drift, lock-missing, unlocked-install', () => {
  const root = fixture({
    'package.json': { name: 'app', dependencies: { react: '^18.0.0', husky: '^9.0.0' } },
    'package-lock.json': lockWith({ react: '^17.0.0' }, ['react']),
    'src/a.ts': "import _ from 'lodash'; import R from 'react';",
    'e2e/a.spec.ts': "import axe from 'axe-core';",
    'cf-build.sh': 'npm install --no-save --ignore-scripts \\\n  react@18 @fontsource/caveat\n',
  });
  try {
    const keys = analyze(root).map((f) => f.key);
    assert.deepEqual(keys, [
      'lock-missing:husky',
      'lock-root-drift:husky',
      'lock-root-drift:react',
      'undeclared:axe-core',
      'undeclared:lodash',
      'unlocked-install:@fontsource/caveat',
    ]);
    const lodash = analyze(root).find((f) => f.key === 'undeclared:lodash');
    assert.match(lodash.detail, /^runtime import/);
    assert.match(analyze(root).find((f) => f.key === 'undeclared:axe-core').detail, /^dev import/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyze: workspace package names are not undeclared', () => {
  const root = fixture({
    'package.json': { name: 'app' },
    'packages/sdk/package.json': { name: '@vireek/sdk' },
    'src/a.ts': "import { Vireek } from '@vireek/sdk';",
  });
  try {
    assert.deepEqual(analyze(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyze: invalid package.json is a single blocking finding', () => {
  const root = fixture({ 'package.json': '{ "scripts": { "a": "x"\n "b": "y" } }' });
  try {
    const f = analyze(root);
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, 'invalid-json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('baseline ratchet: new fails, fixed is stale, notes survive a rewrite', () => {
  const root = fixture({
    'package.json': { name: 'app' },
    'src/a.ts': "import _ from 'lodash';",
  });
  try {
    const first = analyze(root);
    writeBaseline(root, first);
    const body = JSON.parse(readFileSync(path.join(root, BASELINE_FILE), 'utf8'));
    body.entries[0].note = 'owner: platform, ticket 42';
    writeFileSync(path.join(root, BASELINE_FILE), JSON.stringify(body));

    assert.deepEqual(compare(first, readBaseline(root)).added, []);

    writeFileSync(path.join(root, 'src/b.ts'), "import dayjs from 'dayjs';");
    assert.deepEqual(compare(analyze(root), readBaseline(root)).added.map((f) => f.key), ['undeclared:dayjs']);

    writeBaseline(root, analyze(root));
    const after = JSON.parse(readFileSync(path.join(root, BASELINE_FILE), 'utf8'));
    assert.equal(after.entries.find((e) => e.key === 'undeclared:lodash').note, 'owner: platform, ticket 42');

    rmSync(path.join(root, 'src/a.ts'));
    assert.deepEqual(compare(analyze(root), readBaseline(root)).fixed.map((e) => e.key), ['undeclared:lodash']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
