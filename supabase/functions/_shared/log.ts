// supabase/functions/_shared/log.ts
//
// Shared structured logger for edge functions. One JSON line per call, same shape the code used before
// (`{ event, ...fields }`), so existing log queries keep working. Use this instead of console.log; the
// code-health ratchet (scripts/check-code-health.mjs) blocks new console.log/debug in production paths.
//
// Never pass secrets, transcripts, phone numbers or bodies. For untrusted values use
// observability/redact.ts (scrubValue) before logging.

export type LogFields = Record<string, unknown>;

function line(level: "info" | "warn" | "error", fields: LogFields): string {
  try {
    return JSON.stringify(level === "info" ? fields : { level, ...fields });
  } catch {
    return JSON.stringify({ level, event: String(fields.event ?? "log_unserializable") });
  }
}

/** Structured info line. `fields.event` should be a stable snake_case name. */
export function logInfo(fields: LogFields): void { console.info(line("info", fields)); }
export function logWarn(fields: LogFields): void { console.warn(line("warn", fields)); }
export function logError(fields: LogFields): void { console.error(line("error", fields)); }
