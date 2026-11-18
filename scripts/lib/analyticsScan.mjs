// scripts/lib/analyticsScan.mjs
// Static scanner shared by scripts/check-analytics-registry.mjs and src/lib/analyticsEvents.test.ts.
// Finds every trackEvent()/trackRegisteredEvent() call (and any raw gtag('event')) under src/ and reports calls that use
// an unregistered event name, an unregistered or PII-looking property key, or a name that cannot be verified statically.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const SKIP_FILE = /(\.test\.[tj]sx?|\.d\.ts)$/;
/** Files that implement the pipeline itself. */
const IMPLEMENTATION = new Set(['src/lib/analytics.ts', 'src/lib/analyticsEvents.ts']);
const CALLEES = new Set(['trackEvent', 'trackRegisteredEvent']);
const ANNOTATION = /analytics-events:\s*([a-z0-9_,\s]+)/;

export function listSourceFiles(root, dir = 'src') {
  const out = [];
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    const st = statSync(join(root, rel));
    if (st.isDirectory()) out.push(...listSourceFiles(root, rel));
    else if (/\.(ts|tsx)$/.test(entry) && !SKIP_FILE.test(entry)) out.push(rel);
  }
  return out;
}

/** String values the expression can take when it only consists of literals, ternaries and parentheses; null otherwise. */
function literalNames(node) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return literalNames(node.expression);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return literalNames(node.expression);
  if (ts.isConditionalExpression(node)) {
    const a = literalNames(node.whenTrue), b = literalNames(node.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  return null;
}

/** True for an identifier that is a value reference: not an import/export name, a declaration, or a called function. */
function isIndirectReference(id) {
  const p = id.parent;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isFunctionDeclaration(p) || (ts.isVariableDeclaration(p) && p.name === id)) return false;
  if (ts.isCallExpression(p) && p.expression === id) return false;
  if (ts.isPropertyAccessExpression(p)) {
    if (p.name !== id) return true; // `trackEvent.something`
    return !(p.parent && ts.isCallExpression(p.parent) && p.parent.expression === p); // `analytics.trackEvent(...)` is a call
  }
  return true;
}

function objectKeys(node) {
  if (!ts.isObjectLiteralExpression(node)) return null;
  const keys = [];
  for (const p of node.properties) {
    if (ts.isSpreadAssignment(p)) {
      const unwrap = (e) => (ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e);
      const spread = unwrap(p.expression);
      const inner = ts.isConditionalExpression(spread) ? [unwrap(spread.whenTrue), unwrap(spread.whenFalse)] : [spread];
      for (const e of inner) {
        const nested = objectKeys(e);
        if (nested) keys.push(...nested);
        else if (!(ts.isObjectLiteralExpression(e) && e.properties.length === 0)) keys.push(null); // unknowable spread
      }
    } else if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))) keys.push(p.name.text);
    else keys.push(null); // computed key
  }
  return keys;
}

/**
 * @param {{ root: string, registry: Record<string, any>, piiNameRe: RegExp, files?: Record<string,string> }} opts
 *   `files` (path -> source) lets tests scan in-memory fixtures instead of the disk.
 * @returns {{ errors: string[], callCount: number, usedEvents: Set<string> }}
 */
export function scanAnalyticsCalls({ root, registry, piiNameRe, files }) {
  const errors = [];
  const usedEvents = new Set();
  let callCount = 0;
  const sources = files ?? Object.fromEntries(listSourceFiles(root).map((f) => [f, readFileSync(join(root, f), 'utf8')]));

  for (const [file, text] of Object.entries(sources)) {
    const rel = relative(root, join(root, file)).replaceAll('\\', '/');
    if (IMPLEMENTATION.has(rel) || SKIP_FILE.test(rel)) continue;
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const lines = text.split('\n');
    const where = (node) => `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;

    const visit = (node) => {
      // A bare reference (`track: trackEvent`, `const t = trackEvent`) hides the call from the scan: it must declare its events.
      if (ts.isIdentifier(node) && CALLEES.has(node.text) && isIndirectReference(node)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        const note = [lines[line], lines[line - 1]].map((l) => ANNOTATION.exec(l ?? '')).find(Boolean);
        if (!note) errors.push(`${where(node)}: "${node.text}" is passed around uncalled; add "// analytics-events: a, b" above it listing every event it may send`);
        else for (const n of note[1].split(',').map((x) => x.trim()).filter(Boolean)) {
          usedEvents.add(n);
          if (!Object.prototype.hasOwnProperty.call(registry, n)) errors.push(`${where(node)}: event "${n}" is not in the registry (src/lib/analyticsEvents.ts)`);
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
        // Raw GA access bypasses the registry and the consent gate.
        if (callee === 'gtag' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === 'event') {
          errors.push(`${where(node)}: raw gtag('event', ...) is forbidden; use trackEvent() from @/lib/analytics`);
        }
        if (CALLEES.has(callee) && node.arguments.length > 0) {
          callCount++;
          const nameArg = node.arguments[0];
          let names = literalNames(nameArg);
          let annotated = false;
          if (!names) {
            const line = sf.getLineAndCharacterOfPosition(nameArg.getStart(sf)).line;
            const note = [lines[line], lines[line - 1]].map((l) => ANNOTATION.exec(l ?? '')).find(Boolean);
            if (note) { names = note[1].split(',').map((s) => s.trim()).filter(Boolean); annotated = true; }
            else errors.push(`${where(node)}: event name is not statically verifiable; use a string literal or add "// analytics-events: a, b" above the call`);
          }
          for (const n of names ?? []) {
            usedEvents.add(n);
            if (!Object.prototype.hasOwnProperty.call(registry, n)) errors.push(`${where(node)}: event "${n}" is not in the registry (src/lib/analyticsEvents.ts)`);
          }
          const paramArg = node.arguments[1];
          // A typed pass-through wrapper (`...args`) is verified by the compiler through EventArgs<N>.
          if (paramArg && !(annotated && ts.isSpreadElement(paramArg))) {
            const keys = objectKeys(paramArg);
            if (keys === null) errors.push(`${where(node)}: pass an object literal as parameters so keys can be verified`);
            else for (const k of keys) {
              if (k === null) { errors.push(`${where(node)}: computed or spread keys cannot be verified; write the keys out`); continue; }
              if (piiNameRe.test(k)) errors.push(`${where(node)}: property "${k}" looks like PII or free text`);
              for (const n of names ?? []) {
                const def = registry[n];
                if (def && !Object.prototype.hasOwnProperty.call(def.properties, k)) errors.push(`${where(node)}: property "${k}" is not registered for "${n}"`);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { errors, callCount, usedEvents };
}

/** Event names listed in the first column of the tracking-plan tables: lines like "| `event_name` | ...". */
export function eventsInPlan(markdown) {
  return new Set([...markdown.matchAll(/^\|\s*`([a-z][a-z0-9_]*)`\s*\|/gm)].map((m) => m[1]));
}
