// Edge-function reader for the PLATFORM endorsement flag. Env is read at call time; any missing
// Deno global (Vitest/Node) means "OFF". Same variables as the web app, with an optional
// un-prefixed form so Supabase secrets don't need a VITE_ name.
//   PLATFORM_ENDORSEMENT_ENABLED | VITE_PLATFORM_ENDORSEMENT_ENABLED   = true | 1
//   PLATFORM_PARENT_NAME         | VITE_PLATFORM_PARENT_NAME
//   PLATFORM_PARENT_URL          | VITE_PLATFORM_PARENT_URL
import { resolveEndorsement } from "../../../../src/lib/brand/endorsement.ts";

function env(name: string): string | undefined {
  const deno = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno;
  try {
    return deno?.env?.get(name) ?? deno?.env?.get(`VITE_${name}`);
  } catch {
    return undefined; // permission denied -> treat as unset
  }
}

/** "Part of {parent}" for platform-sent system emails, or null (flag OFF / parent unset). */
export function platformEndorsementLine(): string | null {
  return resolveEndorsement({
    enabled: env("PLATFORM_ENDORSEMENT_ENABLED"),
    parentName: env("PLATFORM_PARENT_NAME"),
    parentUrl: env("PLATFORM_PARENT_URL"),
  }).line;
}
