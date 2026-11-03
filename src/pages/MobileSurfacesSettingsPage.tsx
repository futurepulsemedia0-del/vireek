import { useCallback, useEffect, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { isNative } from '@/lib/native/platform';
import { getNativePushState, subscribeNativePush } from '@/lib/native/push';
import { loadMobileSurfacePrefs, saveMobileSurfacePrefs } from '@/lib/native/mobileSurfacesApi';
import {
  DEFAULT_MOBILE_SURFACE_PREFS,
  type MobileSurfaceKey,
  type MobileSurfacePrefs,
} from '@/lib/native/mobileSurfacesCore';

const cardClass = 'mb-6 rounded-xl border border-border bg-bg-secondary p-4';
const btnPrimary =
  'focus-ring inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50';

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-accent' : 'bg-bg-tertiary'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

// Only settings that already change real behavior are editable. The rest are stored defaults for the
// native surfaces that ship in later app releases, so they are shown but locked (no fake switches).
const ACTIVE_ROWS: { key: MobileSurfaceKey; label: string; help: string }[] = [
  {
    key: 'hide_customer_names',
    label: 'Hide customer names and addresses on the lock screen',
    help: 'Emergency, missed-call, payment and job alerts show a generic message until you open the app.',
  },
  {
    key: 'time_sensitive_enabled',
    label: 'Let urgent alerts break through Focus modes',
    help: 'iPhone: urgent alerts are delivered as Time Sensitive. You can still change this per Focus in iOS Settings.',
  },
];

const PLANNED_ROWS: { key: MobileSurfaceKey; label: string }[] = [
  { key: 'live_activities_enabled', label: 'Live Activities / ongoing notifications' },
  { key: 'widgets_enabled', label: 'Home and lock-screen widgets' },
  { key: 'watch_enabled', label: 'Apple Watch and Wear OS' },
  { key: 'voice_assistant_enabled', label: 'Siri and Google Assistant' },
];

export function MobileSurfacesSettingsPage() {
  const { showToast } = useToast();
  const [prefs, setPrefs] = useState<MobileSurfacePrefs>({ ...DEFAULT_MOBILE_SURFACE_PREFS });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<MobileSurfaceKey | null>(null);
  const [pushState, setPushState] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const native = isNative();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setPrefs(await loadMobileSurfacePrefs());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your mobile settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    if (native) void getNativePushState().then(setPushState);
  }, [load, native]);

  async function change(key: MobileSurfaceKey, value: boolean) {
    const previous = prefs[key];
    setPrefs((p) => ({ ...p, [key]: value }));
    setBusyKey(key);
    try {
      await saveMobileSurfacePrefs({ [key]: value });
    } catch (e) {
      setPrefs((p) => ({ ...p, [key]: previous }));
      showToast(e instanceof Error ? e.message : 'Could not save your mobile settings.', 'error');
    } finally {
      setBusyKey(null);
    }
  }

  async function enablePush() {
    setPushBusy(true);
    const result = await subscribeNativePush();
    setPushBusy(false);
    if (!result.success) showToast(result.error ?? 'Could not enable notifications.', 'error');
    setPushState(await getNativePushState());
  }

  return (
    <DashboardLayout activeLabel="Mobile Alerts">
      <div className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="mb-1 flex items-center gap-2 text-xl font-semibold text-text-primary">
          <Smartphone className="h-5 w-5" aria-hidden="true" /> Mobile alerts
        </h1>
        <p className="mb-6 text-sm text-text-secondary">
          These settings are personal to you and apply to the Vireek Field app on your phone.
        </p>

        {loading && <p className="text-sm text-text-secondary" role="status">Loading…</p>}

        {loadError && (
          <div className={cardClass} role="alert">
            <p className="mb-3 text-sm text-text-primary">{loadError}</p>
            <button type="button" className={btnPrimary} onClick={() => void load()}>Try again</button>
          </div>
        )}

        {!loading && !loadError && (
          <>
            {native && pushState !== 'subscribed' && (
              <div className={cardClass}>
                <p className="mb-1 text-sm font-medium text-text-primary">Notifications are {pushState === 'denied' ? 'blocked' : 'off'} on this phone</p>
                <p className="mb-3 text-sm text-text-secondary">
                  {pushState === 'denied'
                    ? 'Turn notifications on for Vireek Field in your phone’s Settings to get emergency and missed-call alerts.'
                    : 'Turn them on to get emergency calls, missed calls and job updates as they happen.'}
                </p>
                {pushState !== 'denied' && (
                  <button type="button" className={btnPrimary} disabled={pushBusy} onClick={() => void enablePush()}>
                    Turn on notifications
                  </button>
                )}
              </div>
            )}

            <div className={cardClass}>
              {ACTIVE_ROWS.map((row) => (
                <div key={row.key} className="flex items-start justify-between gap-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-text-primary">{row.label}</p>
                    <p className="text-xs text-text-secondary">{row.help}</p>
                  </div>
                  <Toggle label={row.label} checked={prefs[row.key]} disabled={busyKey === row.key} onChange={(v) => void change(row.key, v)} />
                </div>
              ))}
            </div>

            <div className={cardClass}>
              <p className="mb-1 text-sm font-medium text-text-primary">Coming in a later app update</p>
              <p className="mb-2 text-xs text-text-secondary">These are not active yet, so they cannot be changed.</p>
              {PLANNED_ROWS.map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-4 py-2">
                  <p className="text-sm text-text-secondary">{row.label}</p>
                  <Toggle label={row.label} checked={prefs[row.key]} disabled onChange={() => undefined} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
