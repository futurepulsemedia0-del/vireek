// Offline harness: transpiles TS on demand, resolves '@/' to src/, stubs supabase + i18n, minimal vitest shim.
const fs = require('fs'), path = require('path'), Module = require('module'), assert = require('assert');
const ts = require('/home/claude/.npm-global/lib/node_modules/typescript');
const SRC = '/home/claude/w/vireek-main/src', OUT = '/tmp/out3';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'package.json'), '{"type":"commonjs"}');
const compile = (file) => {
  const rel = path.relative(SRC, file).replace(/\.tsx?$/, '.js');
  const dest = path.join(OUT, rel); fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, ts.transpileModule(fs.readFileSync(file, 'utf8').replace(/import\.meta\.env/g, '({DEV:false,PROD:true,MODE:"test"})'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText);
  return dest;
};
fs.writeFileSync(path.join(OUT, 'stub-supabase.js'), 'const h={get:(t,k)=>k==="__esModule"?false:()=>h2};const h2=new Proxy(function(){},{get:(t,k)=>k==="then"?undefined:h2,apply:()=>h2});module.exports={supabase:new Proxy({}, {get:()=>h2})};');
fs.writeFileSync(path.join(OUT, 'stub-empty.js'), 'module.exports={default:{}};');
let pass = 0, fail = 0; const failures = []; let suite = '';
const mk = (actual, neg) => {
  const chk = (ok, msg) => { if (neg ? ok : !ok) throw new Error((neg ? 'NOT ' : '') + msg); };
  return {
    get not() { return mk(actual, !neg); },
    toBe: (e) => chk(Object.is(actual, e), `expected ${JSON.stringify(actual)} toBe ${JSON.stringify(e)}`),
    toEqual: (e) => { let ok = true; try { assert.deepStrictEqual(actual, e); } catch { ok = false; } chk(ok, `expected ${JSON.stringify(actual)} toEqual ${JSON.stringify(e)}`); },
    toContain: (e) => chk(actual.includes(e), `expected ${JSON.stringify(actual).slice(0,160)} toContain ${JSON.stringify(e)}`),
    toMatch: (r) => chk(r.test(actual), `expected ${JSON.stringify(actual).slice(0,160)} toMatch ${r}`),
    toBeGreaterThan: (n) => chk(actual > n, `${actual} > ${n}`), toBeGreaterThanOrEqual: (n) => chk(actual >= n, `${actual} >= ${n}`),
    toBeLessThan: (n) => chk(actual < n, `${actual} < ${n}`), toBeLessThanOrEqual: (n) => chk(actual <= n, `${actual} <= ${n}`),
    toBeCloseTo: (n, d = 2) => chk(Math.abs(actual - n) < Math.pow(10, -d) / 2, `${actual} ≈ ${n}`),
    toHaveLength: (n) => chk(actual.length === n, `length ${actual.length} === ${n}`),
    toBeNull: () => chk(actual === null, `${actual} null`),
    toMatchObject: (o) => { const ok = Object.keys(o).every(k => { try { assert.deepStrictEqual(actual[k], o[k]); return true; } catch { return false; } }); chk(ok, `expected ${JSON.stringify(actual)} toMatchObject ${JSON.stringify(o)}`); },
    toThrow: () => { let t = false; try { actual(); } catch { t = true; } chk(t, 'toThrow'); },
  };
};
const vi = { fn: () => () => undefined, mock: () => undefined };
global.__vt = { describe: (n, f) => { const p = suite; suite = n; f(); suite = p; }, it: (n, f) => { try { f(); pass++; } catch (e) { fail++; failures.push(`${suite} › ${n}: ${e.message}`); } }, expect: (a) => mk(a, false), vi };
fs.writeFileSync(path.join(OUT, 'vitest-shim.js'), 'module.exports = global.__vt;');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...r) {
  if (req === 'vitest') return path.join(OUT, 'vitest-shim.js');
  if (req === '@/lib/supabase') return path.join(OUT, 'stub-supabase.js');
  if (req === '@/i18n') return path.join(OUT, 'stub-empty.js');
  if (req.startsWith('@/')) { const base = path.join(SRC, req.slice(2)); const f = ['.ts', '.tsx', '/index.ts'].map(e => base + e).find(fs.existsSync); if (f) return compile(f); }
  if (req.startsWith('.') && parent && parent.filename.startsWith(OUT)) {
    const srcDir = path.dirname(path.join(SRC, path.relative(OUT, parent.filename))); const base = path.resolve(srcDir, req);
    const f = ['.ts', '.tsx'].map(e => base + e).find(fs.existsSync); if (f) return compile(f);
  }
  return orig.call(this, req, parent, ...r);
};
const tests = process.argv.slice(2);
for (const t of tests) { console.log('== ' + path.basename(t)); require(compile(t)); }
console.log(`PASS ${pass}  FAIL ${fail}`);
failures.forEach(f => console.log(' ✗ ' + f));
process.exit(fail ? 1 : 0);
