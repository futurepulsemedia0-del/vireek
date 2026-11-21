#!/usr/bin/env node
// scripts/check-package-script-refs.mjs
//
// Fails when a `package.json` script points at something that does not exist:
//   * a file it runs      (`node scripts/foo.mjs`, `node --test a.test.mjs`, `vitest -c x.config.ts`,
//                          `tsc -p tsconfig.x.json`, `playwright test e2e/x.spec.ts`, `./run.sh`)
//   * another npm script  (`npm run docs:inventory && ...`)
// and when `package.json` contains duplicate keys (JSON.parse silently keeps the LAST one, so the
// earlier definition is dead code that looks live in review).
//
// Pre-existing debt lives in scripts/package-script-refs.baseline.json (a ratchet):
//   * a NEW broken reference                      -> error
//   * a baselined reference that is now fixed     -> error ("remove it from the baseline")
//   * --strict                                    -> baseline ignored, every broken reference is an error
//
// Zero dependencies (Node built-ins only), offline, no `npm ci` needed.
//
// Usage:
//   node scripts/check-package-script-refs.mjs                  # CI mode (honours the baseline)
//   node scripts/check-package-script-refs.mjs --strict         # release branches: no baseline
//   node scripts/check-package-script-refs.mjs --write-baseline # regenerate the baseline (keeps existing notes)
//   node scripts/check-package-script-refs.mjs --root <dir>     # check another checkout (used by tests)
//
// Known limits (deliberate, to avoid false positives): shell expansion (`$VAR`, `$(...)`, globs, braces)
// is not evaluated; arguments to a script after its entry file are not checked (they may be output paths).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINE_FILE = 'scripts/package-script-refs.baseline.json';

// ---------------------------------------------------------------------------------------------
// Shell tokenising
// ---------------------------------------------------------------------------------------------

/**
 * Splits a command line into segments (separated by `&&`, `||`, `;`, `|`, `&`), each an array of
 * tokens. Honours single/double quotes and backslash escapes. Redirections (`> file`, `2>&1`) are dropped.
 * @param {string} command
 * @returns {string[][]}
 */
export function splitShell(command) {
  const segments = [];
  let tokens = [];
  let cur = '';
  let has = false;
  let quote = null;

  const pushToken = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };
  const endSegment = () => {
    pushToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      cur += command[++i];
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    if (ch === '&' || ch === '|' || ch === ';') {
      // `2>&1` and `>&2` are redirections, not command separators.
      if (ch === '&' && /(^|[^\s])>$/.test(cur)) {
        cur += ch;
        has = true;
        continue;
      }
      endSegment();
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
    has = true;
  }
  endSegment();

  // Drop redirections: `>file`, `2>file`, `>>file`, `2>&1`, and the target of a bare `>` / `2>`.
  return segments
    .map((seg) => {
      const out = [];
      for (let i = 0; i < seg.length; i++) {
        const t = seg[i];
        if (/^\d*>>?$/.test(t) || /^\d*<$/.test(t)) {
          i++; // bare operator: skip its target as well
          continue;
        }
        if (/^\d*[<>]/.test(t)) continue;
        out.push(t);
      }
      return out;
    })
    .filter((seg) => seg.length);
}

// ---------------------------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------------------------

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['cross-env', 'npx', 'env', 'exec', 'time']);
const NODE_LIKE = new Set(['node', 'bash', 'sh', 'zsh', 'python', 'python3', 'deno', 'bun', 'tsx', 'ts-node']);
const NODE_VALUE_FLAGS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file',
  '--conditions', '-C', '--input-type', '--title', '--inspect-port',
]);
const NODE_EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print']);
const FILE_EXT = /\.(?:[cm]?[jt]sx?|json|sh|sql|ya?ml)$/i;

// Flags whose VALUE is an input file that must exist, per tool.
const CONFIG_FLAGS = {
  tsc: ['-p', '--project', '-b', '--build'],
  vitest: ['-c', '--config'],
  vite: ['-c', '--config'],
  eslint: ['-c', '--config'],
  playwright: ['-c', '--config'],
  stryker: ['-c', '--config'],
  prettier: ['--config', '--ignore-path'],
  default: ['--config'],
};
// Flags whose value is an OUTPUT or a name, never an input file.
const SKIP_VALUE_FLAGS = new Set([
  '-o', '--out', '--outDir', '--out-dir', '--outfile', '--output', '--cache-location', '--mode',
  '--project', '--reporter', '--grep', '--port', '-p', '--host', '--base', '--shard', '--workers',
]);

const hasShellMagic = (t) => /[$*?{}`]|:\/\//.test(t);

/**
 * @typedef {{ kind: 'file' | 'node-entry' | 'npm-script', target: string }} Ref
 */

/**
 * Extracts references from one script's command string.
 * @param {string} command
 * @returns {Ref[]}
 */
export function extractRefs(command) {
  /** @type {Ref[]} */
  const refs = [];
  const add = (kind, target) => {
    if (!target || hasShellMagic(target)) return;
    refs.push({ kind, target: target.replace(/^\.\//, '') });
  };

  for (const seg of splitShell(command)) {
    let i = 0;
    // Leading env assignments and wrappers: `FOO=1 cross-env BAR=2 npx tsc ...`
    for (;;) {
      if (i < seg.length && ENV_ASSIGN.test(seg[i])) i++;
      else if (i < seg.length && WRAPPERS.has(seg[i])) {
        i++;
        while (i < seg.length && seg[i].startsWith('-') && seg[i] !== '--') i++; // npx -y / --no-install
      } else break;
    }
    if (i >= seg.length) continue;
    const cmd = seg[i];
    const args = seg.slice(i + 1);

    // npm run <script> / npm run-script <script> / npm test
    if (cmd === 'npm') {
      if (args[0] === 'run' || args[0] === 'run-script') {
        const name = args.slice(1).find((a) => !a.startsWith('-'));
        if (name) refs.push({ kind: 'npm-script', target: name });
      } else if (args[0] === 'test' || args[0] === 't') {
        refs.push({ kind: 'npm-script', target: 'test' });
      }
      continue;
    }

    // Direct executable path: `./scripts/run.sh`, `scripts/run.sh`
    if (cmd.includes('/') && !cmd.includes('node_modules/.bin') && !hasShellMagic(cmd)) {
      add('file', cmd);
      continue;
    }

    if (NODE_LIKE.has(cmd)) {
      extractNodeLike(cmd, args, add);
      continue;
    }

    extractGenericTool(cmd, args, add);
  }
  return refs;
}

function extractNodeLike(cmd, args, add) {
  let i = 0;
  if ((cmd === 'deno' || cmd === 'bun') && args[0] === 'run') i = 1;
  let testMode = false;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (NODE_EVAL_FLAGS.has(a)) return; // inline code, nothing on disk to check
    if (a === '--test') {
      testMode = true;
      continue;
    }
    if (a.startsWith('-')) {
      if (!a.includes('=') && NODE_VALUE_FLAGS.has(a)) i++; // swallow the flag's value
      continue;
    }
    if (testMode) {
      add('file', a);
      continue;
    }
    add('node-entry', a); // first positional is the entry file; the rest are its arguments
    return;
  }
}

function extractGenericTool(cmd, args, add) {
  const configFlags = new Set(CONFIG_FLAGS[cmd] ?? CONFIG_FLAGS.default);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      const flag = eq === -1 ? a : a.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : a.slice(eq + 1);
      if (configFlags.has(flag)) {
        add('file', inlineValue ?? args[++i]);
      } else if (SKIP_VALUE_FLAGS.has(flag) && inlineValue === undefined) {
        i++;
      }
      continue;
    }
    if (FILE_EXT.test(a)) add('file', a);
  }
}

// ---------------------------------------------------------------------------------------------
// Duplicate JSON keys
// ---------------------------------------------------------------------------------------------

/**
 * Finds duplicate object keys anywhere in a JSON text (JSON.parse hides them).
 * @param {string} text
 * @returns {{ path: string, key: string, line: number }[]}
 */
export function findDuplicateKeys(text) {
  const dups = [];
  /** @type {{ type: 'obj' | 'arr', keys: Set<string>, expectKey: boolean, path: string[] }[]} */
  const stack = [];
  let lastKey = null;
  let line = 1;
  let i = 0;

  const readString = () => {
    let out = '';
    i++; // opening quote
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        const next = text[i + 1];
        if (next === 'u') {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[next] ?? next;
        i += 2;
        continue;
      }
      if (text[i] === '\n') line++;
      out += text[i++];
    }
    i++; // closing quote
    return out;
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      line++;
      i++;
    } else if (ch === '{' || ch === '[') {
      const parent = stack[stack.length - 1];
      const segment = parent ? (parent.type === 'obj' ? lastKey ?? '' : '[]') : '';
      stack.push({
        type: ch === '{' ? 'obj' : 'arr',
        keys: new Set(),
        expectKey: ch === '{',
        path: parent ? [...parent.path, segment] : [],
      });
      lastKey = null;
      i++;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      lastKey = null;
      i++;
    } else if (ch === ',') {
      const top = stack[stack.length - 1];
      if (top && top.type === 'obj') top.expectKey = true;
      i++;
    } else if (ch === ':') {
      const top = stack[stack.length - 1];
      if (top && top.type === 'obj') top.expectKey = false;
      i++;
    } else if (ch === '"') {
      const startLine = line;
      const value = readString();
      const top = stack[stack.length - 1];
      if (top && top.type === 'obj' && top.expectKey) {
        if (top.keys.has(value)) dups.push({ path: top.path.join('.') || '(root)', key: value, line: startLine });
        top.keys.add(value);
        lastKey = value;
      }
    } else {
      i++;
    }
  }
  return dups;
}

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ script: string, file: string, note?: string }} BaselineEntry
 * @typedef {{ script: string, kind: Ref['kind'], target: string }} Broken
 */

const keyOf = (script, target) => `${script}::${target}`;

/**
 * Pure analysis, no I/O (the caller injects `exists`), so it is unit-testable.
 * @param {{ pkgText: string, exists: (relPath: string) => boolean, baseline?: BaselineEntry[], strict?: boolean }} input
 */
export function analyze({ pkgText, exists, baseline = [], strict = false }) {
  const pkg = JSON.parse(pkgText);
  const scripts = pkg.scripts ?? {};
  const duplicateKeys = findDuplicateKeys(pkgText);

  const nodeResolves = (t) =>
    exists(t) ||
    ['.js', '.cjs', '.mjs', '.json'].some((e) => exists(t + e)) ||
    exists(path.posix.join(t, 'index.js'));

  /** @type {Broken[]} */
  const broken = [];
  const seen = new Set();
  for (const [script, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue;
    for (const ref of extractRefs(command)) {
      const k = keyOf(script, ref.target);
      if (seen.has(k)) continue;
      seen.add(k);
      const ok =
        ref.kind === 'npm-script'
          ? Object.hasOwn(scripts, ref.target)
          : ref.kind === 'node-entry'
            ? nodeResolves(ref.target)
            : exists(ref.target);
      if (!ok) broken.push({ script, kind: ref.kind, target: ref.target });
    }
  }

  const baselineKeys = new Map(baseline.map((b) => [keyOf(b.script, b.file), b]));
  const brokenKeys = new Set(broken.map((b) => keyOf(b.script, b.target)));

  const newBroken = strict ? broken : broken.filter((b) => !baselineKeys.has(keyOf(b.script, b.target)));
  const baselined = strict ? [] : broken.filter((b) => baselineKeys.has(keyOf(b.script, b.target)));
  const staleBaseline = strict ? [] : baseline.filter((b) => !brokenKeys.has(keyOf(b.script, b.file)));

  return {
    scriptCount: Object.keys(scripts).length,
    duplicateKeys,
    broken,
    newBroken,
    baselined,
    staleBaseline,
    ok: duplicateKeys.length === 0 && newBroken.length === 0 && staleBaseline.length === 0,
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function loadBaseline(root) {
  const file = path.join(root, BASELINE_FILE);
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(data.entries)) throw new Error(`${BASELINE_FILE}: "entries" must be an array`);
  for (const e of data.entries) {
    if (typeof e.script !== 'string' || typeof e.file !== 'string') {
      throw new Error(`${BASELINE_FILE}: every entry needs string "script" and "file" (got ${JSON.stringify(e)})`);
    }
  }
  return data.entries;
}

function main(argv) {
  const rootArg = argv.indexOf('--root');
  const root = path.resolve(rootArg === -1 ? path.join(path.dirname(fileURLToPath(import.meta.url)), '..') : argv[rootArg + 1]);
  const strict = argv.includes('--strict');
  const writeBaseline = argv.includes('--write-baseline');

  const pkgText = readFileSync(path.join(root, 'package.json'), 'utf8');
  const baseline = writeBaseline ? [] : loadBaseline(root);
  const result = analyze({ pkgText, exists: (p) => existsSync(path.join(root, p)), baseline, strict });

  if (writeBaseline) {
    const previous = new Map(loadBaseline(root).map((b) => [keyOf(b.script, b.file), b.note]));
    const entries = result.broken
      .map((b) => ({
        script: b.script,
        file: b.target,
        note: previous.get(keyOf(b.script, b.target)) ?? 'TRIAGE: referenced by package.json but absent from the repository; implement it or delete the script.',
      }))
      .sort((a, b) => a.script.localeCompare(b.script) || a.file.localeCompare(b.file));
    const out = {
      $comment:
        'Known-broken package.json script references (ratchet). Only ever shrink this list: fix the script or delete it, then remove the entry. Checked by scripts/check-package-script-refs.mjs.',
      entries,
    };
    mkdirSync(path.dirname(path.join(root, BASELINE_FILE)), { recursive: true });
    writeFileSync(path.join(root, BASELINE_FILE), JSON.stringify(out, null, 2) + '\n');
    console.log(`Wrote ${BASELINE_FILE} with ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.`);
    return 0;
  }

  for (const d of result.duplicateKeys) {
    console.log(`::error file=package.json,line=${d.line}::Duplicate key "${d.key}" in ${d.path}: JSON.parse keeps the last one, the earlier definition is dead. Delete one.`);
  }
  for (const b of result.newBroken) {
    const what = b.kind === 'npm-script' ? `runs \`npm run ${b.target}\`, which is not defined in package.json` : `references "${b.target}", which does not exist`;
    console.log(`::error file=package.json::Script "${b.script}" ${what}.`);
  }
  for (const s of result.staleBaseline) {
    console.log(`::error file=${BASELINE_FILE}::Baseline entry "${s.script}" -> "${s.file}" is resolved (or the script was removed). Delete it from the baseline.`);
  }
  for (const b of result.baselined) {
    console.log(`::warning file=package.json::Known debt: script "${b.script}" -> "${b.target}" is missing (baselined).`);
  }

  const summary = `package.json scripts: ${result.scriptCount} checked, ${result.broken.length} broken reference(s) (${result.baselined.length} baselined, ${result.newBroken.length} new), ${result.duplicateKeys.length} duplicate key(s), ${result.staleBaseline.length} stale baseline entr${result.staleBaseline.length === 1 ? 'y' : 'ies'}.`;
  if (result.ok) {
    console.log(`OK. ${summary}`);
    return 0;
  }
  console.log(`FAILED. ${summary}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
