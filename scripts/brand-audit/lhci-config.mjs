#!/usr/bin/env node
// Writes lighthouserc.brand-audit.json from KEY_ROUTES.public so the Lighthouse URL list has ONE source (config.mjs).
//   node scripts/brand-audit/lhci-config.mjs [--base http://localhost:4173] > lighthouserc.brand-audit.json
import { KEY_ROUTES } from './config.mjs';
const i = process.argv.indexOf('--base');
const base = i > -1 ? process.argv[i + 1] : 'http://localhost:4173';
process.stdout.write(`${JSON.stringify({
  ci: {
    collect: {
      startServerCommand: 'npm run preview -- --port 4173 --strictPort',
      startServerReadyPattern: 'Local',
      startServerReadyTimeout: 60000,
      url: KEY_ROUTES.public.map((p) => `${base}${p}`),
      numberOfRuns: 2,
      settings: { preset: 'desktop', chromeFlags: '--no-sandbox --disable-dev-shm-usage', skipAudits: ['uses-http2'] },
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci' },
  },
}, null, 2)}\n`);
