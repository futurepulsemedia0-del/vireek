// Build-time reader for the platform endorsement flag (same variables the app reads via Vite).
// process.env wins over .env files, matching Vite's precedence. Anything but "true"/"1" is OFF.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function fromDotenv(root, key) {
  for (const f of ['.env.production.local', '.env.local', '.env.production', '.env']) {
    const p = path.join(root, f);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

export function isEndorsementEnabled(root, env = process.env) {
  const raw = env.VITE_PLATFORM_ENDORSEMENT_ENABLED ?? fromDotenv(root, 'VITE_PLATFORM_ENDORSEMENT_ENABLED') ?? '';
  return ['true', '1'].includes(String(raw).trim().toLowerCase());
}
