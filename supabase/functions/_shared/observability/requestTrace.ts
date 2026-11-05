// supabase/functions/_shared/observability/requestTrace.ts
//
// The webhook logs with a per-request id, but the trace id depends on the call id which only exists after
// the body is parsed. This small bounded map lets logEvent/logError (which only receive requestId) stamp
// every log line with the call's trace id without changing 80+ call sites.

const MAX = 500;
const map = new Map<string, string>();

export function bindTrace(requestId: string, traceId: string): void {
  if (map.size >= MAX) { const first = map.keys().next().value; if (first !== undefined) map.delete(first); }
  map.set(requestId, traceId);
}
export function traceFor(requestId: string): string | undefined { return map.get(requestId); }
export function releaseTrace(requestId: string): void { map.delete(requestId); }
/** Test helper. */
export function __size(): number { return map.size; }
