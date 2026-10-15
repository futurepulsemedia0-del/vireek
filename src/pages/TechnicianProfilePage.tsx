import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Bell,
  CalendarCheck,
  Loader as Loader2,
  Minus,
  Plus,
  RotateCw,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { fetchMyTechnicianProfile, saveMyAvailability, saveMyPreferences } from '@/lib/technicianProfileApi';
import {
  ALERT_LEAD_OPTIONS,
  MAX_JOBS_MAX,
  MAX_JOBS_MIN,
  clampMaxJobs,
  credentialExpiryState,
  credentialTitle,
  expiryLabel,
  sortCredentials,
  summarizeCredentials,
  type AlertLeadDays,
  type ExpiryState,
  type MyTechnicianProfile,
  type TechnicianPreferences,
} from '@/lib/technicianProfile';

const STATE_STYLE: Record<ExpiryState, string> = {
  expired: 'bg-danger/10 text-danger',
  expiring: 'bg-warning-500/10 text-warning-500',
  pending_renewal: 'bg-accent/10 text-accent',
  valid: 'bg-success-500/10 text-success-500',
  no_expiry: 'bg-bg-tertiary text-text-secondary',
  revoked: 'bg-bg-tertiary text-text-secondary',
};

function Section({ icon: Icon, title, children }: { icon: typeof Bell; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-4">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-text-primary">
        <Icon className="h-4 w-4 text-accent" aria-hidden />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex min-h-[48px] items-center justify-between gap-3 py-1">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        {hint && <p className="text-xs text-text-secondary">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`focus-ring relative h-7 w-12 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-bg-tertiary'}`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`}
        />
      </button>
    </div>
  );
}

export function TechnicianProfilePage() {
  const { toast } = useToast();
  const [profile, setProfile] = useState<MyTechnicianProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [dispatchEnabled, setDispatchEnabled] = useState(true);
  const [maxJobs, setMaxJobs] = useState(6);
  const [savedAvail, setSavedAvail] = useState({ enabled: true, max: 6 });
  const [savingAvail, setSavingAvail] = useState(false);

  const [prefs, setPrefs] = useState<TechnicianPreferences | null>(null);
  const [savedPrefs, setSavedPrefs] = useState<TechnicianPreferences | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const data = await fetchMyTechnicianProfile();
      setProfile(data);
      if (data) {
        setDispatchEnabled(data.member.dispatch_enabled);
        setMaxJobs(data.member.max_jobs_per_day);
        setSavedAvail({ enabled: data.member.dispatch_enabled, max: data.member.max_jobs_per_day });
        setPrefs(data.preferences);
        setSavedPrefs(data.preferences);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const leadDays = prefs?.credential_alert_days ?? 30;
  const credentials = useMemo(() => sortCredentials(profile?.credentials ?? [], leadDays), [profile, leadDays]);
  const summary = useMemo(() => summarizeCredentials(profile?.credentials ?? [], leadDays), [profile, leadDays]);

  const availDirty = dispatchEnabled !== savedAvail.enabled || maxJobs !== savedAvail.max;
  const prefsDirty = !!prefs && !!savedPrefs && JSON.stringify(prefs) !== JSON.stringify(savedPrefs);

  async function submitAvailability() {
    if (savingAvail || !availDirty) return;
    setSavingAvail(true);
    try {
      await saveMyAvailability({ dispatchEnabled, maxJobsPerDay: maxJobs });
      setSavedAvail({ enabled: dispatchEnabled, max: maxJobs });
      toast('Availability updated', 'success');
    } catch {
      toast('Could not save availability — please try again.', 'error');
    } finally {
      setSavingAvail(false);
    }
  }

  async function submitPreferences() {
    if (savingPrefs || !prefs || !prefsDirty) return;
    setSavingPrefs(true);
    try {
      await saveMyPreferences(prefs);
      setSavedPrefs(prefs);
      toast('Notification settings saved', 'success');
    } catch {
      toast('Could not save notification settings — please try again.', 'error');
    } finally {
      setSavingPrefs(false);
    }
  }

  const updatePref = <K extends keyof TechnicianPreferences>(key: K, value: TechnicianPreferences[K]) =>
    setPrefs((p) => (p ? { ...p, [key]: value } : p));

  return (
    <div className="min-h-screen bg-bg-primary pb-10">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-bg-primary/95 px-4 py-4 backdrop-blur">
        <Link
          to="/tech/today"
          aria-label="Back to today's jobs"
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl text-text-secondary hover:bg-bg-tertiary"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-lg font-semibold text-text-primary">My Profile</h1>
          <p className="text-sm text-text-secondary">Credentials, availability and alerts</p>
        </div>
      </header>

      <main className="mx-auto max-w-lg space-y-4 px-4 py-4">
        {loading ? (
          <div className="space-y-4" aria-busy="true" aria-label="Loading your profile">
            <Skeleton className="h-24 w-full rounded-2xl" />
            <Skeleton className="h-40 w-full rounded-2xl" />
            <Skeleton className="h-32 w-full rounded-2xl" />
          </div>
        ) : loadError ? (
          <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-bg-secondary px-6 py-12 text-center">
            <AlertCircle className="h-6 w-6 text-danger" />
            <p className="text-sm text-text-secondary">We couldn't load your profile.</p>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              <RotateCw size={14} />
              Retry
            </Button>
          </div>
        ) : !profile || !prefs ? (
          <EmptyState
            icon={UserRound}
            title="No technician profile linked"
            description="This login isn't connected to a technician on your team. Ask your account owner to send you a team invite."
          />
        ) : (
          <>
            <Section icon={UserRound} title={profile.member.member_name || 'Technician'}>
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-text-secondary">Email</dt>
                  <dd className="min-w-0 truncate text-text-primary">{profile.member.member_email}</dd>
                </div>
                {profile.member.member_phone && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-text-secondary">Phone</dt>
                    <dd className="text-text-primary">{profile.member.member_phone}</dd>
                  </div>
                )}
                {profile.member.service_area && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-text-secondary">Service area</dt>
                    <dd className="text-right text-text-primary">{profile.member.service_area}</dd>
                  </div>
                )}
              </dl>
              {(profile.member.skills.length > 0 || profile.member.languages.length > 0) && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {profile.member.skills.map((s) => (
                    <span key={`s-${s}`} className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent">
                      {s}
                    </span>
                  ))}
                  {profile.member.languages.map((l) => (
                    <span key={`l-${l}`} className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs font-medium text-text-secondary">
                      {l}
                    </span>
                  ))}
                </div>
              )}
            </Section>

            <Section icon={ShieldCheck} title="Credentials">
              {summary.attention > 0 && (
                <div role="status" className="mb-3 flex gap-2 rounded-xl bg-warning-500/10 px-3 py-2.5 text-sm text-text-primary">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-500" aria-hidden />
                  <p>
                    {summary.expired > 0 && `${summary.expired} expired`}
                    {summary.expired > 0 && summary.expiring + summary.pendingRenewal > 0 && ' · '}
                    {summary.expiring > 0 && `${summary.expiring} expiring within ${leadDays} days`}
                    {summary.expiring > 0 && summary.pendingRenewal > 0 && ' · '}
                    {summary.pendingRenewal > 0 && `${summary.pendingRenewal} renewal pending`}
                    . Contact your manager to update them.
                  </p>
                </div>
              )}
              {credentials.length === 0 ? (
                <EmptyState
                  icon={BadgeCheck}
                  title="No credentials on file"
                  description="Licenses and certifications your manager adds will appear here."
                />
              ) : (
                <ul className="space-y-2">
                  {credentials.map((c) => {
                    const state = credentialExpiryState(c, leadDays);
                    return (
                      <li key={c.id} className="rounded-xl border border-border bg-bg-primary p-3">
                        <div className="flex items-start justify-between gap-2">
                          <p className="min-w-0 break-words text-sm font-medium text-text-primary">{credentialTitle(c)}</p>
                          <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_STYLE[state]}`}>
                            {expiryLabel(state, c.expires_at)}
                          </span>
                        </div>
                        <p className="mt-1 break-words text-xs text-text-secondary">
                          {[c.issuing_authority, c.credential_number && `#${c.credential_number}`, c.expires_at && `Valid until ${c.expires_at}`]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>

            <Section icon={CalendarCheck} title="Availability">
              <Toggle
                label="Available for dispatch"
                hint="Turn off to stop receiving new job assignments."
                checked={dispatchEnabled}
                onChange={setDispatchEnabled}
              />
              <div className="mt-2 flex min-h-[48px] items-center justify-between gap-3">
                <p className="text-sm font-medium text-text-primary">Max jobs per day</p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="Decrease max jobs per day"
                    disabled={maxJobs <= MAX_JOBS_MIN}
                    onClick={() => setMaxJobs((n) => clampMaxJobs(n - 1))}
                    className="focus-ring flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-bg-primary text-text-primary disabled:opacity-40"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <span aria-live="polite" className="w-8 text-center text-base font-semibold text-text-primary">
                    {maxJobs}
                  </span>
                  <button
                    type="button"
                    aria-label="Increase max jobs per day"
                    disabled={maxJobs >= MAX_JOBS_MAX}
                    onClick={() => setMaxJobs((n) => clampMaxJobs(n + 1))}
                    className="focus-ring flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-bg-primary text-text-primary disabled:opacity-40"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <Button className="mt-3 w-full" size="sm" onClick={() => void submitAvailability()} disabled={!availDirty || savingAvail}>
                {savingAvail && <Loader2 size={16} className="animate-spin" />}
                {savingAvail ? 'Saving…' : 'Save availability'}
              </Button>
            </Section>

            <Section icon={Bell} title="Notifications">
              <Toggle
                label="Credential expiry alerts"
                hint="Get warned before a license or certification expires."
                checked={prefs.notify_credential_expiry}
                onChange={(v) => updatePref('notify_credential_expiry', v)}
              />
              <div className="flex min-h-[48px] items-center justify-between gap-3 py-1">
                <label htmlFor="alert-lead" className="text-sm font-medium text-text-primary">
                  Warn me
                </label>
                <select
                  id="alert-lead"
                  value={prefs.credential_alert_days}
                  disabled={!prefs.notify_credential_expiry}
                  onChange={(e) => updatePref('credential_alert_days', Number(e.target.value) as AlertLeadDays)}
                  className="focus-ring min-h-[44px] rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary disabled:opacity-50"
                >
                  {ALERT_LEAD_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d} days before
                    </option>
                  ))}
                </select>
              </div>
              <Toggle label="New job assigned" checked={prefs.notify_job_assigned} onChange={(v) => updatePref('notify_job_assigned', v)} />
              <Toggle label="Schedule changes" checked={prefs.notify_schedule_change} onChange={(v) => updatePref('notify_schedule_change', v)} />
              <Button className="mt-3 w-full" size="sm" onClick={() => void submitPreferences()} disabled={!prefsDirty || savingPrefs}>
                {savingPrefs && <Loader2 size={16} className="animate-spin" />}
                {savingPrefs ? 'Saving…' : 'Save notification settings'}
              </Button>
            </Section>
          </>
        )}
      </main>
    </div>
  );
}
