/**
 * Location Privacy — /dashboard/location-privacy
 * Owner / team managers decide when technicians can be tracked (only while clocked in,
 * only with recorded consent) and which roles can see locations. Every consent grant and
 * revoke is kept in an append-only log. Enforced in the database, not just this screen.
 * Needs the account owner or can_manage_team.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Lock, MapPinOff, ShieldCheck, UserCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { FadeIn, SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import {
  CONSENT_LABEL,
  CONSENT_NOTICE_LINES,
  LEVELS,
  LEVEL_HINT,
  LEVEL_LABEL,
  consentStatus,
  errorMessage,
  fetchConsentLog,
  fetchConsentOverview,
  fetchLocationPrivacy,
  mapToRules,
  ruleKey,
  rulesToMap,
  saveLocationPrivacy,
  summarizeConsent,
  type ConsentLogEntry,
  type ConsentOverviewRow,
  type ConsentStatus,
  type LocationPrivacySettings,
  type VisibilityLevel,
} from '@/lib/locationPrivacy';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary disabled:opacity-60';

const STATUS_BADGE: Record<ConsentStatus, string> = {
  granted: 'bg-success-500/10 text-success-500',
  outdated: 'bg-warning-500/10 text-warning-500',
  revoked: 'bg-danger/10 text-danger',
  none: 'bg-bg-tertiary text-text-secondary',
};

type LevelChoice = VisibilityLevel | 'inherit';

interface Draft {
  trackOnlyOnShift: boolean;
  requireConsent: boolean;
  hideVehicleOffDuty: boolean;
  defaultVisibility: VisibilityLevel;
  levels: Record<string, LevelChoice>;
  bumpNotice: boolean;
}

function draftFrom(s: LocationPrivacySettings): Draft {
  return {
    trackOnlyOnShift: s.trackOnlyOnShift,
    requireConsent: s.requireConsent,
    hideVehicleOffDuty: s.hideVehicleOffDuty,
    defaultVisibility: s.defaultVisibility,
    levels: rulesToMap(s.rules),
    bumpNotice: false,
  };
}

function explicitLevels(levels: Record<string, LevelChoice>): string {
  return JSON.stringify(Object.entries(levels).filter(([, v]) => v !== 'inherit').sort());
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.trackOnlyOnShift === b.trackOnlyOnShift &&
    a.requireConsent === b.requireConsent &&
    a.hideVehicleOffDuty === b.hideVehicleOffDuty &&
    a.defaultVisibility === b.defaultVisibility &&
    a.bumpNotice === b.bumpNotice &&
    explicitLevels(a.levels) === explicitLevels(b.levels)
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`focus-ring relative h-8 w-14 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-accent' : 'bg-bg-tertiary'}`}
    >
      <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${checked ? 'left-7' : 'left-1'}`} />
    </button>
  );
}

function SettingRow({ title, hint, checked, onChange, disabled }: { title: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">{title}</p>
        <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>
      </div>
      <Switch checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </li>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: 'bad' | 'good' }) {
  return (
    <Card className="p-4 sm:p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums sm:text-2xl ${tone === 'bad' ? 'text-danger' : tone === 'good' ? 'text-success-500' : 'text-text-primary'}`}>{value}</p>
    </Card>
  );
}

export function LocationPrivacyPage() {
  const navigate = useNavigate();
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canManage = isOwner || permissions.can_manage_team;

  const [settings, setSettings] = useState<LocationPrivacySettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [overview, setOverview] = useState<ConsentOverviewRow[]>([]);
  const [log, setLog] = useState<ConsentLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (!user || !canManage) return;
    const id = ++requestId.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const [s, o, l] = await Promise.all([fetchLocationPrivacy(), fetchConsentOverview(), fetchConsentLog(50)]);
      if (id !== requestId.current) return;
      setSettings(s);
      setDraft(draftFrom(s));
      setOverview(o);
      setLog(l);
    } catch {
      if (id === requestId.current) setLoadFailed(true);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [user, canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => (settings && draft ? !sameDraft(draft, draftFrom(settings)) : false), [settings, draft]);
  const summary = useMemo(() => summarizeConsent(overview, settings?.noticeVersion ?? 1), [overview, settings?.noticeVersion]);

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const handleSave = async () => {
    if (!settings || !draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveLocationPrivacy({
        trackOnlyOnShift: draft.trackOnlyOnShift,
        requireConsent: draft.requireConsent,
        defaultVisibility: draft.defaultVisibility,
        hideVehicleOffDuty: draft.hideVehicleOffDuty,
        rules: mapToRules(draft.levels, settings.roles),
        bumpNotice: draft.bumpNotice,
      });
      toast('Location privacy saved.', 'success');
      await load();
    } catch (e) {
      setSaveError(errorMessage(e, 'Could not save location privacy.'));
    } finally {
      setSaving(false);
    }
  };

  if (!canManage) {
    return (
      <DashboardLayout activeLabel="Location Privacy">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">Ask your account owner for the "Manage Team" permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Location Privacy">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary hover:text-text-primary"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <ShieldCheck size={22} className="text-accent" /> Location privacy
            </h1>
            <p className="text-sm text-text-secondary">Track only on the clock, with consent on record, and show locations only to the roles you choose.</p>
          </div>
        </div>
        {draft && (
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            {dirty && (
              <Button variant="ghost" size="sm" onClick={() => settings && setDraft(draftFrom(settings))} disabled={saving}>
                Discard
              </Button>
            )}
            <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        )}
      </div>

      {saveError && (
        <p role="alert" className="mb-4 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {saveError}
        </p>
      )}

      {loading ? (
        <div className="space-y-6">
          <SkeletonStatGrid count={4} />
          <SkeletonCardList count={3} rows={3} />
        </div>
      ) : loadFailed || !settings || !draft ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load location privacy" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />
      ) : (
        <FadeIn>
          <div className="space-y-6">
            {!settings.configured && (
              <div role="status" className="rounded-2xl border border-warning-500/40 bg-warning-500/10 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <AlertTriangle size={16} className="text-warning-500" /> Not configured yet
                </p>
                <p className="mt-1 text-sm text-text-primary">
                  Right now tracking is not limited to work hours, consent is not required, and everyone on the account can see locations.
                </p>
                <div className="mt-3">
                  <Button variant="secondary" size="sm" onClick={() => patch({ trackOnlyOnShift: true, requireConsent: true })}>
                    Turn on recommended protections
                  </Button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <Kpi label="Consented" value={summary.granted} tone={summary.granted > 0 ? 'good' : undefined} />
              <Kpi label="Waiting on consent" value={summary.pending} />
              <Kpi label="Revoked" value={summary.revoked} />
              <Kpi label="On shift, no consent" value={summary.onShiftWithoutConsent} tone={summary.onShiftWithoutConsent > 0 ? 'bad' : undefined} />
            </div>

            <Card className="p-4 sm:p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <MapPinOff size={16} className="text-accent" /> When technicians are tracked
              </h2>
              <ul className="mt-1 divide-y divide-border/60">
                <SettingRow
                  title="Only track while clocked in"
                  hint="Off-duty location points are dropped by the server, including points synced later from the phone."
                  checked={draft.trackOnlyOnShift}
                  onChange={(v) => patch({ trackOnlyOnShift: v })}
                  disabled={saving}
                />
                <SettingRow
                  title="Require recorded consent"
                  hint="A technician must agree in the app before any location is stored. Withdrawing consent stops tracking immediately."
                  checked={draft.requireConsent}
                  onChange={(v) => patch({ requireConsent: v })}
                  disabled={saving}
                />
                <SettingRow
                  title="Hide a truck while its technician is off duty"
                  hint="Company vehicles stay on the map only during an open shift. The account owner always sees every vehicle."
                  checked={draft.hideVehicleOffDuty}
                  onChange={(v) => patch({ hideVehicleOffDuty: v })}
                  disabled={saving}
                />
              </ul>
              {draft.requireConsent && (
                <label className="mt-2 flex items-start gap-3 rounded-xl bg-bg-tertiary/60 p-3 text-sm text-text-primary">
                  <input
                    type="checkbox"
                    className="focus-ring mt-0.5 h-5 w-5 shrink-0 rounded border-border"
                    checked={draft.bumpNotice}
                    onChange={(e) => patch({ bumpNotice: e.target.checked })}
                    disabled={saving}
                  />
                  <span>
                    Ask everyone to consent again
                    <span className="block text-xs text-text-secondary">Use after the way you use location changes. Current notice: version {settings.noticeVersion}.</span>
                  </span>
                </label>
              )}
            </Card>

            <Card className="p-4 sm:p-5">
              <h2 className="text-sm font-semibold text-text-primary">Who can see locations</h2>
              <p className="mt-0.5 text-xs text-text-secondary">The account owner always sees everything. A technician always sees their own truck.</p>
              <div className="mt-4 max-w-md">
                <label htmlFor="loc-default" className="mb-1.5 block text-sm font-medium text-text-primary">Default for everyone else</label>
                <select
                  id="loc-default"
                  className={selectClass}
                  value={draft.defaultVisibility}
                  disabled={saving}
                  onChange={(e) => patch({ defaultVisibility: e.target.value as VisibilityLevel })}
                >
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>{LEVEL_LABEL[l]}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-text-secondary">{LEVEL_HINT[draft.defaultVisibility]}</p>
              </div>

              {settings.roles.length === 0 ? (
                <p className="mt-4 text-sm text-text-secondary">No team roles yet. Add team members to set visibility per role.</p>
              ) : (
                <ul className="mt-4 divide-y divide-border/60">
                  {settings.roles.map((role) => {
                    const key = ruleKey(role.kind, role.key);
                    const value = draft.levels[key] ?? 'inherit';
                    const effective: VisibilityLevel = value === 'inherit' ? draft.defaultVisibility : value;
                    return (
                      <li key={key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium capitalize text-text-primary">{role.label}</p>
                          <p className="text-xs text-text-secondary">
                            {role.kind === 'custom_role' ? 'Custom role' : 'Team role'} · {LEVEL_LABEL[effective]}
                          </p>
                        </div>
                        <select
                          aria-label={`Location visibility for ${role.label}`}
                          className={`${selectClass} sm:w-60`}
                          value={value}
                          disabled={saving}
                          onChange={(e) => patch({ levels: { ...draft.levels, [key]: e.target.value as LevelChoice } })}
                        >
                          <option value="inherit">Use default</option>
                          {LEVELS.map((l) => (
                            <option key={l} value={l}>{LEVEL_LABEL[l]}</option>
                          ))}
                        </select>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card className="p-4 sm:p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <UserCheck size={16} className="text-accent" /> Technician consent
              </h2>
              {overview.length === 0 ? (
                <p className="mt-3 text-sm text-text-secondary">No team members yet.</p>
              ) : (
                <ul className="mt-3 divide-y divide-border/60">
                  {overview.map((r) => {
                    const st = consentStatus(r, settings.noticeVersion);
                    return (
                      <li key={r.teamMemberId} className="flex items-center justify-between gap-3 py-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-text-primary">{r.name}</p>
                          <p className="truncate text-xs text-text-secondary">
                            {r.role} · {r.onShift ? 'On shift' : 'Off duty'}{r.at ? ` · ${formatWhen(r.at)}` : ''}
                          </p>
                        </div>
                        <span className={`inline-flex shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[st]}`}>
                          {CONSENT_LABEL[st]}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="mt-4 rounded-xl bg-bg-tertiary/60 p-3">
                <p className="text-xs font-semibold text-text-primary">What technicians agree to</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-text-secondary">
                  {CONSENT_NOTICE_LINES.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            </Card>

            <Card className="p-4 sm:p-5">
              <h2 className="text-sm font-semibold text-text-primary">Consent history</h2>
              <p className="mt-0.5 text-xs text-text-secondary">Append-only. Entries can't be edited or deleted.</p>
              {log.length === 0 ? (
                <p className="mt-3 text-sm text-text-secondary">No consent has been recorded yet.</p>
              ) : (
                <ul className="mt-3 divide-y divide-border/60">
                  {log.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">{e.memberName ?? e.memberEmail}</p>
                        <p className="text-xs text-text-secondary">
                          {formatWhen(e.createdAt)} · notice v{e.noticeVersion} · {e.source === 'app' ? 'Mobile app' : 'Web'}
                        </p>
                      </div>
                      <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${e.action === 'granted' ? STATUS_BADGE.granted : STATUS_BADGE.revoked}`}>
                        {e.action === 'granted' ? 'Granted' : 'Revoked'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
