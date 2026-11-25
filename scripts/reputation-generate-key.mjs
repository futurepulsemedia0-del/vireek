// Usage: node scripts/reputation-generate-key.mjs <kid>      (Node 20+)
// Prints (1) the PRIVATE JWK for the edge-function secret and (2) the SQL that registers the PUBLIC key.
// Store the private JWK only in the secret manager: supabase secrets set REPUTATION_SIGNING_KEY_JWK='...' REPUTATION_SIGNING_KID='<kid>'
import { webcrypto as crypto } from 'node:crypto';

const kid = process.argv[2];
if (!kid || !/^[A-Za-z0-9._-]{1,64}$/.test(kid)) { console.error('Usage: node scripts/reputation-generate-key.mjs <kid>  (letters, digits, . _ -)'); process.exit(1); }
const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const pub = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: jwk.x });
const priv = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d });
console.log('--- PRIVATE (secret REPUTATION_SIGNING_KEY_JWK) - never commit, never paste in chat ---\n' + priv);
console.log('\n--- SQL (run once in the Supabase SQL editor) ---');
console.log(`INSERT INTO public.reputation_signing_keys (kid, public_jwk) VALUES ('${kid}', '${pub}'::jsonb) ON CONFLICT (kid) DO NOTHING;`);
