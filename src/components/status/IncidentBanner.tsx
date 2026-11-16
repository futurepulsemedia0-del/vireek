import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface FeedIncident { id: string; title: string; impact: string; status: string; summary: string; resolved_at: string | null }

const POLL_MS = 5 * 60_000;
const DISMISS_PREFIX = 'vireek:incident-dismissed:';

/** In-app incident banner fed by the PUBLIC status-feed edge function (no auth, cached 60 s). */
export function IncidentBanner() {
  const [incident, setIncident] = useState<FeedIncident | null>(null);

  useEffect(() => {
    const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    if (!base) return;
    let alive = true;
    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const res = await fetch(`${base.replace(/\/$/, '')}/functions/v1/status-feed`, { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const body = (await res.json()) as { incidents?: FeedIncident[] };
        const active = (body.incidents ?? []).filter((i) => i.status !== 'resolved' && !i.resolved_at);
        const worst = active.find((i) => i.impact === 'major') ?? active[0] ?? null;
        let dismissed = false;
        try { dismissed = !!worst && sessionStorage.getItem(DISMISS_PREFIX + worst.id) === '1'; } catch { /* storage unavailable */ }
        if (alive) setIncident(worst && !dismissed ? worst : null);
      } catch { /* a failing status feed must never break the app */ }
    };
    void load();
    const t = window.setInterval(() => void load(), POLL_MS);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  if (!incident) return null;
  const major = incident.impact === 'major';
  return (
    <div role={major ? 'alert' : 'status'} className="mb-4 flex items-start gap-3 rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-primary">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{incident.title}</p>
        <p className="text-text-secondary">{incident.summary} <a className="underline" href="/status">Status page</a></p>
      </div>
      <button type="button" aria-label="Dismiss" className="focus-ring rounded p-1 text-text-secondary hover:text-text-primary"
        onClick={() => { try { sessionStorage.setItem(DISMISS_PREFIX + incident.id, '1'); } catch { /* ignore */ } setIncident(null); }}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
