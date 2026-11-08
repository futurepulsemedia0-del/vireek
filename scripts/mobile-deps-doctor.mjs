#!/usr/bin/env node
// scripts/mobile-deps-doctor.mjs — fails when native-plugin imports and package.json/lockfile diverge.
//   npm run mobile:doctor                       dependency checks only (needs no node_modules)
//   npm run mobile:doctor -- --native --app field|home   + generated native project checks (CI, after `cap add/sync`)
// Exit 1 = blocking problem. Warnings never fail.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const native = argv.includes('--native');
const appIdx = argv.indexOf('--app');
const app = appIdx >= 0 ? argv[appIdx + 1] : 'field';
if (!['field', 'home'].includes(app)) {
  console.error('Usage: mobile-deps-doctor.mjs [--native] [--app field|home]');
  process.exit(2);
}

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

const NATIVE =
  /^(@capacitor\/|@capacitor-community\/|@capacitor-firebase\/|@capacitor-mlkit\/|@capgo\/|@aparajita\/capacitor-|@sentry\/capacitor$|capacitor-)/;
const INFRA = new Set(['@capacitor/cli', '@capacitor/android', '@capacitor/ios', '@capacitor/assets']);
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const pkg = readJson('package.json');
if (!pkg) { console.error('package.json not found (run from the repo root)'); process.exit(2); }
const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };

// ---- 1. collect imports -------------------------------------------------------------
const imported = new Map(); // pkg -> Set(files)
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(e.name)) scan(p);
  }
};
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;
function scan(file) {
  const text = readFileSync(file, 'utf8').replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, '');
  for (const m of text.matchAll(SPEC)) {
    const parts = m[2].split('/');
    const name = m[2].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (!NATIVE.test(name)) continue;
    if (!imported.has(name)) imported.set(name, new Set());
    imported.get(name).add(file);
  }
}
if (existsSync('src')) walk('src');
if (existsSync('capacitor.config.ts')) scan('capacitor.config.ts');

for (const [name, files] of imported) {
  if (!declared[name]) err(`${name} is imported (${[...files].slice(0, 3).join(', ')}) but not declared in package.json`);
}
const nativeDeclared = Object.keys(declared).filter((n) => NATIVE.test(n));
for (const n of nativeDeclared) {
  if (!imported.has(n) && !INFRA.has(n)) warn(`${n} is declared but never imported in src/ (ok only if used from native code)`);
}

// ---- 2. required tooling ------------------------------------------------------------
for (const n of ['@capacitor/core', '@capacitor/cli', '@capacitor/android', '@capacitor/ios']) {
  if (!declared[n]) err(`${n} must be declared (Capacitor platform/tooling)`);
}
const scriptsText = Object.values(pkg.scripts ?? {}).join('\n');
if (/capacitor-assets/.test(scriptsText) && !declared['@capacitor/assets']) {
  err('scripts use `capacitor-assets` but @capacitor/assets is not declared');
}

// ---- 3. exact pins ------------------------------------------------------------------
const mustPin = new Set(nativeDeclared);
if (declared['@sentry/capacitor'] && declared['@sentry/react']) mustPin.add('@sentry/react');
for (const n of mustPin) {
  if (declared[n] && !EXACT.test(declared[n])) err(`${n}: "${declared[n]}" is a range — pin an exact version (npm install --save-exact)`);
}

// ---- 4. Capacitor major alignment ----------------------------------------------------
const major = (v) => Number((v ?? '').match(/\d+/)?.[0]);
const coreMajor = major(declared['@capacitor/core']);
if (coreMajor) {
  for (const n of nativeDeclared) {
    if (!n.startsWith('@capacitor/') || n === '@capacitor/assets') continue; // assets & community plugins version independently
    if (declared[n] && major(declared[n]) !== coreMajor) err(`${n}@${declared[n]} does not match @capacitor/core major ${coreMajor}`);
  }
}

// ---- 5. lockfile --------------------------------------------------------------------
const lock = readJson('package-lock.json');
if (!lock) err('package-lock.json is missing');
else {
  for (const n of [...nativeDeclared, ...(mustPin.has('@sentry/react') ? ['@sentry/react'] : [])]) {
    const entry = lock.packages?.[`node_modules/${n}`];
    if (!entry) err(`package-lock.json has no entry for ${n} — run npm install and commit the lockfile`);
    else if (EXACT.test(declared[n] ?? '') && entry.version !== declared[n]) err(`package-lock.json has ${n}@${entry.version} but package.json pins ${declared[n]}`);
  }
  const peer = lock.packages?.['node_modules/@sentry/capacitor']?.peerDependencies?.['@sentry/react'];
  const have = lock.packages?.['node_modules/@sentry/react']?.version;
  if (peer && have) {
    if (EXACT.test(peer)) { if (peer !== have) err(`@sentry/react is ${have} but @sentry/capacitor requires exactly ${peer}`); }
    else warn(`@sentry/capacitor peer range "${peer}" for @sentry/react — verify ${have} satisfies it`);
  }
}

// ---- 6. Node engine required by the Capacitor CLI (only when installed) ---------------
const cliPkg = readJson('node_modules/@capacitor/cli/package.json');
const need = cliPkg?.engines?.node?.match(/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
if (need) {
  const want = [need[1], need[2] ?? 0, need[3] ?? 0].map(Number);
  const got = process.versions.node.split('.').map(Number);
  const ok = got[0] !== want[0] ? got[0] > want[0] : got[1] !== want[1] ? got[1] > want[1] : got[2] >= want[2];
  if (!ok) err(`Node ${process.versions.node} is older than @capacitor/cli requires (${cliPkg.engines.node})`);
} else if (cliPkg) warn('could not parse @capacitor/cli engines.node');

// ---- 7. generated native projects (CI) ----------------------------------------------
if (native) {
  const ids = { field: 'com.vireek.field', home: 'com.vireek.home' };
  const dirs = app === 'field' ? { a: 'android', i: 'ios' } : { a: 'android-home', i: 'ios-home' };
  const files = [
    `${dirs.a}/build.gradle`, `${dirs.a}/settings.gradle`, `${dirs.a}/gradlew`,
    `${dirs.a}/gradle/wrapper/gradle-wrapper.properties`, `${dirs.a}/app/build.gradle`,
    `${dirs.a}/app/src/main/AndroidManifest.xml`,
    `${dirs.i}/App/App.xcodeproj/project.pbxproj`, `${dirs.i}/App/Podfile`,
    `${dirs.i}/App/App/Info.plist`, `${dirs.i}/App/App/PrivacyInfo.xcprivacy`,
  ];
  for (const f of files) if (!existsSync(f)) err(`missing native file: ${f}`);
  const gradle = existsSync(`${dirs.a}/app/build.gradle`) ? readFileSync(`${dirs.a}/app/build.gradle`, 'utf8') : '';
  const gid = gradle.match(/applicationId\s*=?\s*["']([^"']+)["']/)?.[1];
  if (gradle && gid !== ids[app]) err(`${dirs.a}/app/build.gradle applicationId is ${gid ?? 'not found'}, expected ${ids[app]}`);
  const pbxPath = `${dirs.i}/App/App.xcodeproj/project.pbxproj`;
  if (existsSync(pbxPath)) {
    const pbx = readFileSync(pbxPath, 'utf8');
    if (!pbx.includes(`PRODUCT_BUNDLE_IDENTIFIER = ${ids[app]};`)) err(`${pbxPath}: PRODUCT_BUNDLE_IDENTIFIER is not ${ids[app]}`);
    if (!pbx.includes('PrivacyInfo.xcprivacy')) err(`${pbxPath}: PrivacyInfo.xcprivacy is not part of the App target`);
  }
}

for (const e of errors) console.log(`✖ ${e}`);
for (const w of warnings) console.log(`! ${w}`);
console.log(
  errors.length
    ? `\n${errors.length} blocking problem(s), ${warnings.length} warning(s).`
    : `\n✔ mobile dependency doctor passed (${nativeDeclared.length} native packages, ${warnings.length} warning(s)).`,
);
process.exit(errors.length ? 1 : 0);
