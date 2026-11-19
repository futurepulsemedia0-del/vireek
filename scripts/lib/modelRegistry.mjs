// Read model ids from the single registry (supabase/functions/_shared/ai-models.ts) in plain Node scripts,
// which cannot import the TypeScript file. Usage: const model = process.env.GEMINI_MODEL || registryModelId('GEMINI_FLASH');
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'supabase', 'functions', '_shared', 'ai-models.ts');

let cache;
export function registryModelId(key) {
  cache ??= (() => {
    const text = readFileSync(REGISTRY, 'utf8');
    const block = text.match(/export const MODELS\s*=\s*\{([\s\S]*?)\}\s*as const/);
    if (!block) throw new Error('MODELS block not found in ai-models.ts');
    return new Map([...block[1].matchAll(/([A-Z0-9_]+)\s*:\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
  })();
  const id = cache.get(key);
  if (!id) throw new Error(`Unknown model key "${key}" (see supabase/functions/_shared/ai-models.ts)`);
  return id;
}
