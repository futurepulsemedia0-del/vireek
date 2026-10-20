#!/usr/bin/env node
// scripts/cap-home.mjs — runs Capacitor for the "Vireek Home" app (separate native projects).
//   npm run cap:home -- sync          build web (mode=home) + cap sync
//   npm run cap:home -- add ios       create ios-home/   (no web build)
//   npm run cap:home -- add android   create android-home/
//   npm run cap:home -- open ios
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const sub = args[0] ?? 'sync';
const shell = process.platform === 'win32';

function run(cmd, cmdArgs, env = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell, env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!['add', 'open'].includes(sub)) {
  run('npx', ['vite', 'build', '--mode', 'home', '--outDir', 'dist-home']);
}
run('npx', ['cap', ...(args.length ? args : ['sync'])], { VIREEK_APP: 'home' });
