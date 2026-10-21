import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { loadArrivalWindowSettings, saveArrivalWindowSettings } from '@/lib/arrivalWindowsApi';
import {
  ARRIVAL_WINDOW_LENGTHS,
  DEFAULT_ARRIVAL_WINDOW_CONFIG,
  formatLength,
  sanitizeGraceMinutes,
  type ArrivalWindowConfig,
} from '@/lib/arrivalWindows';

const NARROW_CHOICES = [60, 90, 120, 180] as const;
const GRACE_CHOICES = [0, 5, 10, 15, 30] as const;

export function ArrivalWindowSettingsCard() {
  const auth = useAuth();
  const ownerId =
    (auth as unknown as { accountOwnerId?: string }).accountOwnerId ?? auth.teamMember?.account_owner_id ?? auth.user?.id ?? null;

  const [cfg, setCfg] = useState<ArrivalWindowConfig>(DEFAULT_ARRIVAL_WINDOW_CONFIG);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!ownerId) return;
    let cancelled = false;
    loadArrivalWindowSettings(ownerId).then((c) => {
      if (cancelled) return;
      if (c) { setCfg(c); setState('ready'); } else setState('error');
    });
    return () => { cancelled = true; };
  }, [ownerId]);

  const toggleLength = (l: number) =>
    setCfg((c) => {
      const next = c.optionsMinutes.includes(l) ? c.optionsMinutes.filter((x) => x !== l) : [...c.optionsMinutes, l].sort((a, b) => a - b);
      return { ...c, optionsMinutes: next };
    });

  const save = async () => {
    if (!ownerId) return;
    setSaving(true);
    setNote(null);
    const ok = await saveArrivalWindowSettings(ownerId, cfg);
    setSaving(false);
    setNote(ok ? 'Saved.' : 'Could not save. Check your connection and permissions, then try again.');
  };

  const invalid = cfg.enabled && cfg.optionsMinutes.length === 0;

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Arrival windows">
      <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary">
        <Clock size={16} className="text-accent" aria-hidden /> Arrival windows
      </h3>
      <p className="mt-1 text-xs text-text-secondary">
        Offer 1–4 hour windows when customers book. We narrow the window automatically once a technician is assigned and tell the customer.
      </p>

      {state === 'loading' && <div className="mt-4 h-24 animate-pulse rounded-xl bg-bg-primary" aria-busy="true" />}
      {state === 'error' && <p className="mt-4 text-sm text-red-500" role="alert">Could not load arrival-window settings.</p>}

      {state === 'ready' && (
        <div className="mt-4 space-y-5">
          <label className="flex items-center justify-between gap-3 text-sm text-text-primary">
            <span>Offer arrival windows on the booking page</span>
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} className="h-4 w-4 accent-accent" />
          </label>

          <fieldset disabled={!cfg.enabled} className="space-y-5 disabled:opacity-50">
            <div>
              <legend className="mb-2 text-xs font-medium text-text-secondary">Window lengths customers can choose</legend>
              <div className="flex flex-wrap gap-2">
                {ARRIVAL_WINDOW_LENGTHS.map((l) => {
                  const on = cfg.optionsMinutes.includes(l);
                  return (
                    <button key={l} type="button" aria-pressed={on} onClick={() => toggleLength(l)}
                      className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium ${on ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary'}`}>
                      {formatLength(l)}
                    </button>
                  );
                })}
              </div>
              {invalid && <p className="mt-2 text-xs text-red-500">Pick at least one length.</p>}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-xs font-medium text-text-secondary">
                Narrow to this length on dispatch
                <select value={cfg.narrowMinutes} onChange={(e) => setCfg({ ...cfg, narrowMinutes: Number(e.target.value) })}
                  className="focus-ring mt-1 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
                  {NARROW_CHOICES.map((m) => <option key={m} value={m}>{formatLength(m)}</option>)}
                </select>
              </label>
              <label className="block text-xs font-medium text-text-secondary">
                On-time grace period
                <select value={cfg.graceMinutes} onChange={(e) => setCfg({ ...cfg, graceMinutes: sanitizeGraceMinutes(e.target.value) })}
                  className="focus-ring mt-1 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
                  {GRACE_CHOICES.map((m) => <option key={m} value={m}>{m === 0 ? 'None' : `${m} minutes`}</option>)}
                </select>
              </label>
            </div>

            <label className="flex items-center justify-between gap-3 text-sm text-text-primary">
              <span>Notify the customer when their window is confirmed or changes</span>
              <input type="checkbox" checked={cfg.notifyCustomer} onChange={(e) => setCfg({ ...cfg, notifyCustomer: e.target.checked })} className="h-4 w-4 accent-accent" />
            </label>
          </fieldset>

          <div className="flex items-center gap-3">
            <button type="button" onClick={save} disabled={saving || invalid}
              className="focus-ring rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
            {note && <span className="text-xs text-text-secondary" role="status">{note}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
