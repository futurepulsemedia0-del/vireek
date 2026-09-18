/**
 * Weather-Triggered Surge Intelligence — /dashboard/weather-surge
 *
 * Settings + live status for automatic Surge Mode activation, driven by
 * real severe-weather alerts (api.weather.gov) instead of a human
 * remembering to flip a switch mid-storm. See:
 *   - supabase/migrations/20260929000000_weather_surge_intelligence.sql
 *   - supabase/functions/weather-surge-check
 *   - src/lib/weatherSurge.ts
 */

import { useCallback, useEffect, useState } from 'react';
import {
  CloudLightning,
  CloudSnow,
  Flame,
  Wind,
  Droplets,
  RefreshCw,
  Loader2,
  CheckCircle2,
  Clock,
  Power,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  checkWeatherSurgeNow,
  endWeatherSurgeNow,
  fetchWeatherSurgeHistory,
  fetchWeatherSurgeSettings,
  updateWeatherSurgeSettings,
  type WeatherSurgeEvent,
  type WeatherSurgeSettings,
} from '@/lib/weatherSurge';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

function eventIcon(eventType: string) {
  if (eventType.includes('Heat')) return Flame;
  if (eventType.includes('Freeze') || eventType.includes('Cold') || eventType.includes('Winter') || eventType.includes('Ice')) return CloudSnow;
  if (eventType.includes('Wind') || eventType.includes('Hurricane') || eventType.includes('Tropical') || eventType.includes('Tornado')) return Wind;
  if (eventType.includes('Flood')) return Droplets;
  return CloudLightning;
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function EventRow({ event }: { event: WeatherSurgeEvent }) {
  const Icon = eventIcon(event.event_type);
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
      <div
        className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
          event.triggered_surge ? 'bg-cta/15 text-cta' : 'bg-bg-tertiary text-text-secondary'
        }`}
      >
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-text-primary">{event.event_type}</p>
          {event.triggered_surge && (
            <span className="rounded-full bg-cta/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cta">
              Triggered surge
            </span>
          )}
          {event.resolved_at && (
            <span className="rounded-full bg-success-500/10 px-2 py-0.5 text-[10px] font-medium text-success-500">Resolved</span>
          )}
        </div>
        {event.headline && <p className="mt-1 text-xs leading-relaxed text-text-secondary">{event.headline}</p>}
        <p className="mt-1 text-xs text-text-secondary/70">{relativeTime(event.created_at)}</p>
      </div>
    </div>
  );
}

export function WeatherSurgeIntelligencePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [settings, setSettings] = useState<WeatherSurgeSettings | null>(null);
  const [history, setHistory] = useState<WeatherSurgeEvent[]>([]);
  const [zipInput, setZipInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [s, h] = await Promise.all([fetchWeatherSurgeSettings(user.id), fetchWeatherSurgeHistory(20)]);
      setSettings(s);
      setZipInput(s?.weather_zip_code ?? '');
      setHistory(h);
    } catch {
      toast('Could not load weather surge settings.', 'error');
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleEnabled = async () => {
    if (!user || !settings) return;
    const nextEnabled = !settings.weather_surge_enabled;
    if (nextEnabled && !/^\d{5}$/.test(zipInput)) {
      toast('Enter a 5-digit zip code first.', 'error');
      return;
    }
    setSaving(true);
    try {
      await updateWeatherSurgeSettings(user.id, { weather_surge_enabled: nextEnabled, weather_zip_code: zipInput || null });
      setSettings({ ...settings, weather_surge_enabled: nextEnabled, weather_zip_code: zipInput || null });
      toast(nextEnabled ? 'Weather monitoring turned on.' : 'Weather monitoring turned off.', 'success');
    } catch {
      toast('Could not update settings.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveZip = async () => {
    if (!user || !settings) return;
    if (!/^\d{5}$/.test(zipInput)) {
      toast('Enter a valid 5-digit zip code.', 'error');
      return;
    }
    setSaving(true);
    try {
      await updateWeatherSurgeSettings(user.id, { weather_zip_code: zipInput });
      setSettings({ ...settings, weather_zip_code: zipInput });
      toast('Zip code saved.', 'success');
    } catch {
      toast('Could not save zip code.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleCheckNow = async () => {
    setChecking(true);
    try {
      const result = await checkWeatherSurgeNow();
      if ('error' in result) {
        toast(result.error, 'error');
      } else {
        toast(
          result.alerts_triggered > 0
            ? `${result.alerts_triggered} alert(s) triggered Surge Mode.`
            : `Checked — ${result.alerts_seen} alert(s) in your area, nothing that needs surge right now.`,
          'success'
        );
      }
      await load();
    } catch {
      toast('Check failed.', 'error');
    } finally {
      setChecking(false);
    }
  };

  const handleEndSurge = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await endWeatherSurgeNow(user.id);
      toast('Weather-triggered Surge Mode ended.', 'success');
      await load();
    } catch {
      toast('Could not end surge.', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <DashboardLayout activeLabel="Weather Surge">
        <div className="mx-auto max-w-2xl space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />
          ))}
        </div>
      </DashboardLayout>
    );
  }

  const weatherIsDriving = settings?.surge_mode_active && settings?.surge_mode_source === 'weather';

  return (
    <DashboardLayout activeLabel="Weather Surge">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <CloudLightning size={22} className="text-accent" /> Weather-Triggered Surge Intelligence
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
            Watches real severe-weather alerts for your service area and turns Surge Mode on automatically —
            hail, freezes, floods, hurricanes — so your team and Sarah are already prioritizing storm calls
            before your phone starts ringing off the hook.
          </p>
        </div>

        {weatherIsDriving && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-2xl border border-cta/30 bg-cta/[0.07] p-4">
            <div className="flex items-start gap-3">
              <CloudLightning size={18} className="mt-0.5 shrink-0 text-cta" />
              <div>
                <p className="text-sm font-semibold text-text-primary">Surge Mode is active — weather-triggered</p>
                <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">{settings?.surge_mode_note}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleEndSurge()}
              disabled={saving}
              className="focus-ring shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
            >
              End now
            </button>
          </div>
        )}

        <div className="mb-6 rounded-2xl border border-border bg-bg-secondary p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-text-primary">Enable weather monitoring</p>
              <p className="mt-0.5 text-xs text-text-secondary">Off by default — checks your zip code every 15–30 minutes once on.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={!!settings?.weather_surge_enabled}
              onClick={() => void toggleEnabled()}
              disabled={saving}
              className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                settings?.weather_surge_enabled ? 'bg-accent' : 'bg-bg-tertiary'
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                  settings?.weather_surge_enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          <div className="mt-5 border-t border-border/60 pt-5">
            <label htmlFor="weather-zip" className="text-sm font-medium text-text-primary">
              Service area zip code
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="weather-zip"
                type="text"
                inputMode="numeric"
                maxLength={5}
                value={zipInput}
                onChange={(e) => setZipInput(e.target.value.replace(/\D/g, ''))}
                placeholder="80202"
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => void saveZip()}
                disabled={saving}
                className="focus-ring shrink-0 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-between gap-4 border-t border-border/60 pt-5">
            <div className="flex items-center gap-1.5 text-xs text-text-secondary">
              <Clock size={13} />
              Last checked: {relativeTime(settings?.weather_surge_last_checked_at ?? null)}
            </div>
            <button
              type="button"
              onClick={() => void handleCheckNow()}
              disabled={checking || !settings?.weather_zip_code}
              className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
            >
              {checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Check now
            </button>
          </div>
        </div>

        <h2 className="mb-3 text-sm font-semibold text-text-primary">Alert history</h2>
        {history.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-10 text-center">
            <Power className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="text-sm text-text-secondary">No weather alerts recorded yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {history.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>
        )}

        <p className="mt-6 flex items-center gap-1.5 text-xs text-text-secondary/70">
          <CheckCircle2 size={12} />
          Powered by the National Weather Service's public alerts API. Only alerts relevant to your trade
          trigger Surge Mode — everything else is logged here for reference only.
        </p>
      </div>
    </DashboardLayout>
  );
}
