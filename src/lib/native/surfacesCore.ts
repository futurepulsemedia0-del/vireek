// src/lib/native/surfacesCore.ts — pure helpers shared by the native bridge (unit tested, no Capacitor imports).

export interface SurfaceSnapshot {
  generated_at: string;
  calls_answered: number;
  calls_missed: number;
  revenue_recovered_cents: number;
  next_job: { id: string; service: string; scheduled_at: string; scheduled_ms: number } | null;
  on_call: { name: string; is_me: boolean } | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Validates the RPC result before it is stored on the phone; returns null for anything malformed. */
export function parseSnapshot(raw: unknown): SurfaceSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const generatedRaw = str(r.generated_at, 40);
  const generatedMs = Date.parse(generatedRaw);
  if (!generatedRaw || Number.isNaN(generatedMs)) return null;
  const generated = new Date(generatedMs).toISOString(); // 3-digit ms + Z: parses on every platform (Postgres emits 6 digits)
  const nj = r.next_job as Record<string, unknown> | null | undefined;
  const oc = r.on_call as Record<string, unknown> | null | undefined;
  const jobId = nj ? str(nj.id, 64) : '';
  const when = nj ? str(nj.scheduled_at, 40) : '';
  return {
    generated_at: generated,
    calls_answered: num(r.calls_answered),
    calls_missed: num(r.calls_missed),
    revenue_recovered_cents: num(r.revenue_recovered_cents),
    next_job: jobId && !Number.isNaN(Date.parse(when)) ? { id: jobId, service: str(nj?.service, 60) || 'Job', scheduled_at: when, scheduled_ms: Date.parse(when) } : null,
    on_call: oc && str(oc.name, 80) ? { name: str(oc.name, 80), is_me: oc.is_me === true } : null,
  };
}

/** Notification action ids (iOS category actions) → in-app path. Unknown ids fall back to the notification's own url. */
const ACTION_PATHS: Record<string, string> = {
  ANSWER: '/dashboard/live-calls',
  CALLBACK: '/dashboard/calls',
  ASSIGN: '/dashboard/dispatch',
  DISPATCH: '/dashboard/dispatch',
  OPEN_JOB: '/tech/today',
};

export function resolveActionPath(actionId: string | undefined, fallbackUrl: string | null): string | null {
  if (!actionId || actionId === 'tap' || actionId === 'DEFAULT') return fallbackUrl;
  if (actionId === 'SNOOZE') return null; // handled natively; never navigates
  return ACTION_PATHS[actionId] ?? fallbackUrl;
}

/** Local day boundary needs the device time zone; sent to the RPC so "today" matches the technician's day. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
