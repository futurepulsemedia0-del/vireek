// supabase/functions/_shared/ai-core/keyHealthStore.ts
//
// Best-effort persistence of credential HEALTH METADATA (label, status, cool-down, counters) into
// `ai_credential_health`. It NEVER stores or logs a secret or any derivative of one.
// Never throws and never blocks a request: observability must not break an AI call.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { shouldPersist } from "./keyPool.ts";
import type { KeyEvent } from "./keyPool.ts";

const lastWrite = new Map<string, number>();
let cachedClient: ReturnType<typeof createClient> | null = null;

function db() {
  if (cachedClient) return cachedClient;
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

export function recordKeyEvent(e: KeyEvent): void {
  const id = `${e.provider}:${e.label}:${e.kind}`;
  if (!shouldPersist(e, lastWrite.get(id))) return;
  lastWrite.set(id, e.at);

  const client = db();
  if (!client) return;

  void client
    .rpc("record_ai_credential_event", {
      p_provider: e.provider,
      p_label: e.label,
      p_kind: e.kind,
      p_cooldown_until: e.cooldownUntil ? new Date(e.cooldownUntil).toISOString() : null,
    })
    .then(({ error }: { error: { code?: string } | null }) => {
      if (error) console.error("[ai-key-health] persist failed:", error.code ?? "unknown");
    })
    .catch(() => {
      /* swallow: best effort */
    });
}
