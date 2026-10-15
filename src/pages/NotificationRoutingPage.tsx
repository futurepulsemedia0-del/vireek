import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BellRing, FlaskConical, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { supabase, type TeamMember } from '@/lib/supabase';
import {
  ALL_DAYS,
  CHANNELS,
  CHANNEL_LABELS,
  DAY_LABELS,
  DELIVERY_STATUS_COLORS,
  NOTIFICATION_TYPE_OPTIONS,
  ROLE_LABELS,
  RULE_TEMPLATES,
  SEVERITIES,
  SEVERITY_COLORS,
  SEVERITY_DESCRIPTIONS,
  SEVERITY_LABELS,
  TARGET_LABELS,
  describeRule,
  draftToRow,
  emptyDraft,
  hasErrors,
  ruleToDraft,
  skipReasonLabel,
  validateDraft,
  type Channel,
  type DeliveryRow,
  type PreviewResult,
  type RoutingRule,
  type RoutingSettings,
  type RuleDraft,
  type Severity,
  type TargetRole,
  type TargetType,
} from '@/lib/notificationRouting';
import {
  createRule,
  deleteRule,
  getSettings,
  listDeliveries,
  listRules,
  listSchedules,
  previewRouting,
  saveSettings,
  sendTestAlert,
  updateRule,
  type ScheduleOption,
} from '@/lib/notificationRoutingApi';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary transition-colors';
const cardClass = 'mb-6 rounded-xl border border-border bg-bg-secondary p-4';
const btnPrimary =
  'focus-ring inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50';
const btnGhost =
  'focus-ring inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-primary hover:bg-bg-tertiary disabled:opacity-50';

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-bg-tertiary'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  );
}

function FieldError({ message }: { message?: string }) {
  return message ? <p role="alert" className="mt-1 text-xs text-error-500">{message}</p> : null;
}

function toggleIn<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function NotificationRoutingPage() {
  const { isOwner } = useAuth();
  const { showToast } = useToast();

  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [settings, setSettings] = useState<RoutingSettings | null>(null);
  const [schedules, setSchedules] = useState<ScheduleOption[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [toDelete, setToDelete] = useState<RoutingRule | null>(null);

  const [slackInput, setSlackInput] = useState('');
  const [slackBusy, setSlackBusy] = useState(false);

  const [previewType, setPreviewType] = useState('emergency_call');
  const [previewSeverity, setPreviewSeverity] = useState<Severity>('critical');
  const [previewAt, setPreviewAt] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [r, d, s, sch, tm] = await Promise.all([
        listRules(),
        listDeliveries(),
        getSettings(),
        listSchedules(),
        supabase.from('team_members').select('*').eq('invite_status', 'active'),
      ]);
      setRules(r);
      setDeliveries(d);
      setSettings(s);
      setSchedules(sch);
      setTeam((tm.data ?? []) as TeamMember[]);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load notification routing.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const lookup = useMemo(
    () => ({
      memberName: (id: string) => team.find((t) => t.id === id)?.member_name ?? team.find((t) => t.id === id)?.member_email ?? null,
      scheduleName: (id: string) => schedules.find((s) => s.id === id)?.name ?? null,
    }),
    [team, schedules],
  );
  const ruleNames = useMemo(() => new Map(rules.map((r) => [r.id, r.name])), [rules]);

  const errors = draft ? validateDraft(draft) : {};
  const selectedSchedule = draft ? schedules.find((s) => s.id === draft.schedule_id) : undefined;

  const openNew = (over: Partial<RuleDraft> = {}) => {
    setShowErrors(false);
    const first = schedules[0]?.id ?? '';
    const needsSchedule = over.target_type === 'on_call' || over.escalate_if_unacked;
    setDraft(emptyDraft({ ...over, schedule_id: needsSchedule ? first : '' }));
  };

  const save = async () => {
    if (!draft) return;
    setShowErrors(true);
    if (hasErrors(validateDraft(draft))) return;
    setSaving(true);
    try {
      if (draft.id) await updateRule(draft.id, draftToRow(draft));
      else await createRule(draftToRow(draft));
      showToast(draft.id ? 'Rule saved' : 'Rule created', 'success');
      setDraft(null);
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save the rule', 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (rule: RoutingRule) => {
    const previous = rules;
    setRules((rs) => rs.map((r) => (r.id === rule.id ? { ...r, is_active: !r.is_active } : r)));
    try {
      await updateRule(rule.id, { is_active: !rule.is_active });
    } catch (e) {
      setRules(previous);
      showToast(e instanceof Error ? e.message : 'Could not update the rule', 'error');
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    try {
      await deleteRule(toDelete.id);
      showToast('Rule deleted', 'success');
      setToDelete(null);
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not delete the rule', 'error');
    }
  };

  const connectSlack = async () => {
    setSlackBusy(true);
    try {
      await saveSettings({ slackWebhookUrl: slackInput.trim() });
      setSlackInput('');
      showToast('Slack connected', 'success');
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not connect Slack', 'error');
    } finally {
      setSlackBusy(false);
    }
  };

  const disconnectSlack = async () => {
    setSlackBusy(true);
    try {
      await saveSettings({ clearSlack: true });
      showToast('Slack disconnected', 'success');
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not disconnect Slack', 'error');
    } finally {
      setSlackBusy(false);
    }
  };

  const setFallback = async (value: boolean) => {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, fallback_to_push: value });
    try {
      await saveSettings({ fallbackToPush: value });
    } catch (e) {
      setSettings(previous);
      showToast(e instanceof Error ? e.message : 'Could not save the setting', 'error');
    }
  };

  const runPreview = async () => {
    setPreviewBusy(true);
    try {
      setPreview(await previewRouting({ type: previewType, severity: previewSeverity, at: previewAt ? new Date(previewAt).toISOString() : undefined }));
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Preview failed', 'error');
    } finally {
      setPreviewBusy(false);
    }
  };

  const runTest = async () => {
    setTestBusy(true);
    try {
      await sendTestAlert();
      showToast('Test alert sent — check the delivery log in a few seconds', 'success');
      setTimeout(() => { void load(); }, 4000);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not send the test alert', 'error');
    } finally {
      setTestBusy(false);
    }
  };

  if (!isOwner) {
    return (
      <DashboardLayout activeLabel="Notification Routing">
        <div className="mx-auto max-w-2xl px-4 py-12 text-center text-text-secondary">
          Only the account owner can change notification routing.
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Notification Routing">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <BellRing size={20} />
            </span>
            <div>
              <h1 className="text-xl font-semibold text-text-primary">Notification Routing</h1>
              <p className="text-sm text-text-secondary">Decide who gets which alert, on which channel, and what happens if nobody responds.</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" className={btnGhost} onClick={runTest} disabled={testBusy || rules.length === 0}>
              <Send size={14} /> {testBusy ? 'Sending…' : 'Send test alert'}
            </button>
            <button type="button" className={btnPrimary} onClick={() => openNew()}>
              <Plus size={14} /> New rule
            </button>
          </div>
        </div>

        {loading && <div className="p-8 text-text-secondary" role="status">Loading…</div>}

        {!loading && loadError && (
          <div role="alert" className="mb-6 rounded-xl border border-error-500/30 bg-error-500/5 p-4 text-sm text-error-500">
            {loadError}{' '}
            <button type="button" className="underline" onClick={() => { setLoading(true); void load(); }}>Try again</button>
          </div>
        )}

        {!loading && !loadError && (
          <>
            {/* Rules */}
            <section className={cardClass} aria-labelledby="rules-h">
              <h2 id="rules-h" className="mb-1 text-sm font-semibold text-text-primary">Rules</h2>
              <p className="mb-3 text-xs text-text-secondary">
                Lower priority numbers run first. If two rules reach the same person on the same channel, they get it once.
                {rules.some((r) => r.is_active) ? '' : ' With no active rule, every alert is pushed to all devices — as before.'}
              </p>

              {rules.length === 0 && (
                <div className="rounded-lg border border-dashed border-border p-4">
                  <p className="mb-3 text-sm text-text-secondary">No rules yet. Start from a recommended setup:</p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {RULE_TEMPLATES.map((t) => (
                      <button key={t.id} type="button" onClick={() => openNew(t.draft)} className="focus-ring rounded-lg border border-border bg-bg-primary p-3 text-left hover:border-accent">
                        <span className="block text-sm font-medium text-text-primary">{t.title}</span>
                        <span className="mt-1 block text-xs text-text-secondary">{t.blurb}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <ul className="space-y-2">
                {rules.map((r) => (
                  <li key={r.id} className={`rounded-lg border border-border bg-bg-primary p-3 ${r.is_active ? '' : 'opacity-60'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-text-primary">{r.name}</span>
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_COLORS[r.min_severity]}`}>{SEVERITY_LABELS[r.min_severity]}+</span>
                          <span className="text-xs text-text-secondary">priority {r.priority}</span>
                        </div>
                        <p className="mt-1 text-xs text-text-secondary">{describeRule(r, lookup)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Toggle checked={r.is_active} onChange={() => void toggleActive(r)} label={`${r.is_active ? 'Disable' : 'Enable'} ${r.name}`} />
                        <button type="button" aria-label={`Edit ${r.name}`} onClick={() => { setShowErrors(false); setDraft(ruleToDraft(r)); }} className="focus-ring rounded p-1.5 text-text-secondary hover:text-accent"><Pencil size={14} /></button>
                        <button type="button" aria-label={`Delete ${r.name}`} onClick={() => setToDelete(r)} className="focus-ring rounded p-1.5 text-text-secondary hover:text-error-500"><Trash2 size={14} /></button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            {/* Preview */}
            <section className={cardClass} aria-labelledby="preview-h">
              <h2 id="preview-h" className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary"><FlaskConical size={14} /> Who would be notified?</h2>
              <p className="mb-3 text-xs text-text-secondary">Simulates your rules — nothing is sent. Pick a different date/time to test after-hours rules.</p>
              <div className="grid gap-2 sm:grid-cols-4">
                <select aria-label="Alert type" value={previewType} onChange={(e) => setPreviewType(e.target.value)} className={inputClass}>
                  {NOTIFICATION_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <select aria-label="Severity" value={previewSeverity} onChange={(e) => setPreviewSeverity(e.target.value as Severity)} className={inputClass}>
                  {SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>)}
                </select>
                <input aria-label="Simulate at" type="datetime-local" value={previewAt} onChange={(e) => setPreviewAt(e.target.value)} className={inputClass} />
                <button type="button" className={btnPrimary} onClick={runPreview} disabled={previewBusy}>{previewBusy ? 'Checking…' : 'Preview'}</button>
              </div>

              {preview && (
                <div className="mt-3 rounded-lg border border-border bg-bg-primary p-3 text-sm" aria-live="polite">
                  {preview.matched_rules.length === 0 ? (
                    <p className="text-text-secondary">
                      No rule matches.{' '}
                      {preview.fallback_to_push ? 'It would be pushed to all devices (fallback is on).' : 'Nobody would be notified outside the app (fallback is off).'}
                    </p>
                  ) : (
                    <>
                      <ul className="space-y-1">
                        {preview.deliveries.map((d, i) => (
                          <li key={i} className="flex flex-wrap items-center justify-between gap-2">
                            <span>{CHANNEL_LABELS[d.channel]} → <strong>{d.recipient}</strong> <span className="text-xs text-text-secondary">({d.rule})</span></span>
                            {d.skip_reason ? (
                              <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-xs text-warning-500">{skipReasonLabel(d.skip_reason)}</span>
                            ) : (
                              <span className="rounded-full bg-success-500/10 px-2 py-0.5 text-xs text-success-500">Will send</span>
                            )}
                          </li>
                        ))}
                      </ul>
                      {preview.escalations.length > 0 && (
                        <p className="mt-2 text-xs text-text-secondary">Escalation would start via “{preview.escalations.map((e) => e.rule).join(', ')}” if nobody acknowledges.</p>
                      )}
                    </>
                  )}
                </div>
              )}
            </section>

            {/* Settings */}
            <section className={cardClass} aria-labelledby="settings-h">
              <h2 id="settings-h" className="mb-3 text-sm font-semibold text-text-primary">Channels &amp; fallback</h2>
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-text-primary">Push to all devices when no rule matches</p>
                  <p className="text-xs text-text-secondary">Keeps alerts from being missed while you tune your rules.</p>
                </div>
                <Toggle checked={settings?.fallback_to_push ?? true} onChange={(v) => void setFallback(v)} label="Push to all devices when no rule matches" />
              </div>

              <div>
                <p className="mb-1 text-sm text-text-primary">Slack</p>
                {settings?.slack_configured ? (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm">
                    <span>Connected <span className="text-text-secondary">({settings.slack_hint})</span></span>
                    <button type="button" className={btnGhost} onClick={disconnectSlack} disabled={slackBusy}>Disconnect</button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      type="url"
                      aria-label="Slack incoming webhook URL"
                      value={slackInput}
                      onChange={(e) => setSlackInput(e.target.value)}
                      placeholder="https://hooks.slack.com/services/…"
                      className={inputClass}
                      autoComplete="off"
                    />
                    <button type="button" className={btnPrimary} onClick={connectSlack} disabled={slackBusy || !slackInput.trim()}>Connect</button>
                  </div>
                )}
                <p className="mt-1 text-xs text-text-secondary">Create an Incoming Webhook in Slack for the channel your team watches. The URL is stored securely and never shown again.</p>
              </div>
            </section>

            {/* Delivery log */}
            <section className="rounded-xl border border-border bg-bg-secondary p-4" aria-labelledby="log-h">
              <h2 id="log-h" className="mb-3 text-sm font-semibold text-text-primary">Recent deliveries</h2>
              {deliveries.length === 0 && <p className="text-sm text-text-secondary">Nothing routed yet. Use “Send test alert” to try your rules end to end.</p>}
              <ul className="space-y-2">
                {deliveries.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm">
                    <span className="min-w-0">
                      {CHANNEL_LABELS[d.channel]} → {d.recipient_label ?? '—'}
                      <span className="ml-2 text-xs text-text-secondary">{d.notification_type} · {d.rule_id ? ruleNames.get(d.rule_id) ?? 'deleted rule' : 'fallback'} · {new Date(d.created_at).toLocaleString()}</span>
                      {d.error && d.status !== 'sent' && <span className="block text-xs text-text-secondary">{skipReasonLabel(d.error)}</span>}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${DELIVERY_STATUS_COLORS[d.status]}`}>{d.status}</span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>

      {/* Rule editor */}
      {draft && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={draft.id ? 'Edit rule' : 'New rule'}>
          <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 sm:rounded-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-text-primary">{draft.id ? 'Edit rule' : 'New rule'}</h2>
              <button type="button" aria-label="Close" onClick={() => setDraft(null)} className="focus-ring rounded p-1 text-text-secondary hover:text-text-primary"><X size={18} /></button>
            </div>

            <div className="space-y-5">
              <div>
                <label htmlFor="nr-name" className="mb-1 block text-xs font-medium text-text-secondary">Rule name</label>
                <input id="nr-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={80} placeholder="e.g. After-hours emergencies" className={inputClass} />
                {showErrors && <FieldError message={errors.name} />}
              </div>

              <div>
                <p className="mb-1 text-xs font-medium text-text-secondary">Which alerts <span className="font-normal">(none selected = all types)</span></p>
                <div className="flex flex-wrap gap-2">
                  {NOTIFICATION_TYPE_OPTIONS.map((o) => (
                    <Chip key={o.value} active={draft.notification_types.includes(o.value)} onClick={() => setDraft({ ...draft, notification_types: toggleIn(draft.notification_types, o.value) })}>{o.label}</Chip>
                  ))}
                </div>
                <label htmlFor="nr-sev" className="mb-1 mt-3 block text-xs font-medium text-text-secondary">Minimum severity</label>
                <select id="nr-sev" value={draft.min_severity} onChange={(e) => setDraft({ ...draft, min_severity: e.target.value as Severity })} className={inputClass}>
                  {SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABELS[s]} — {SEVERITY_DESCRIPTIONS[s]}</option>)}
                </select>
              </div>

              <div>
                <label htmlFor="nr-target" className="mb-1 block text-xs font-medium text-text-secondary">Who gets it</label>
                <select
                  id="nr-target"
                  value={draft.target_type}
                  onChange={(e) => {
                    const target_type = e.target.value as TargetType;
                    setDraft({ ...draft, target_type, schedule_id: draft.schedule_id || (target_type === 'on_call' ? schedules[0]?.id ?? '' : '') });
                  }}
                  className={inputClass}
                >
                  {(Object.keys(TARGET_LABELS) as TargetType[]).map((t) => <option key={t} value={t}>{TARGET_LABELS[t]}</option>)}
                </select>

                {draft.target_type === 'role' && (
                  <select aria-label="Role" value={draft.target_role} onChange={(e) => setDraft({ ...draft, target_role: e.target.value as TargetRole | '' })} className={`${inputClass} mt-2`}>
                    <option value="">Choose a role…</option>
                    {(Object.keys(ROLE_LABELS) as TargetRole[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                )}
                {draft.target_type === 'member' && (
                  <select aria-label="Person" value={draft.target_member_id} onChange={(e) => setDraft({ ...draft, target_member_id: e.target.value })} className={`${inputClass} mt-2`}>
                    <option value="">Choose a person…</option>
                    {team.map((t) => <option key={t.id} value={t.id}>{t.member_name ?? t.member_email}</option>)}
                  </select>
                )}
                {showErrors && <FieldError message={errors.target} />}
              </div>

              <div>
                <p className="mb-1 text-xs font-medium text-text-secondary">Channels</p>
                <div className="flex flex-wrap gap-2">
                  {CHANNELS.map((c: Channel) => (
                    <Chip key={c} active={draft.channels.includes(c)} onClick={() => setDraft({ ...draft, channels: toggleIn(draft.channels, c) })}>{CHANNEL_LABELS[c]}</Chip>
                  ))}
                </div>
                {draft.channels.includes('slack') && !settings?.slack_configured && <p className="mt-1 text-xs text-warning-500">Slack isn’t connected yet — connect it under “Channels &amp; fallback”.</p>}
                {showErrors && <FieldError message={errors.channels} />}
              </div>

              <div>
                <p className="mb-1 text-xs font-medium text-text-secondary">When this rule applies</p>
                <div className="flex flex-wrap gap-2">
                  {ALL_DAYS.map((d) => (
                    <Chip key={d} active={draft.active_days.includes(d)} onClick={() => setDraft({ ...draft, active_days: toggleIn(draft.active_days, d) })}>{DAY_LABELS[d]}</Chip>
                  ))}
                </div>
                {showErrors && <FieldError message={errors.days} />}
                <div className="mt-3 flex items-center gap-3">
                  <Toggle checked={draft.window_enabled} onChange={(v) => setDraft({ ...draft, window_enabled: v })} label="Limit to a time window" />
                  <span className="text-sm text-text-primary">Only between</span>
                  <input aria-label="Window start" type="time" disabled={!draft.window_enabled} value={draft.window_start} onChange={(e) => setDraft({ ...draft, window_start: e.target.value })} className={`${inputClass} w-32`} />
                  <span className="text-sm text-text-secondary">and</span>
                  <input aria-label="Window end" type="time" disabled={!draft.window_enabled} value={draft.window_end} onChange={(e) => setDraft({ ...draft, window_end: e.target.value })} className={`${inputClass} w-32`} />
                </div>
                {draft.window_enabled && draft.window_start > draft.window_end && <p className="mt-1 text-xs text-text-secondary">Overnight window: runs from the start time until the end time the next morning.</p>}
                {showErrors && <FieldError message={errors.window} />}
                <label htmlFor="nr-tz" className="mb-1 mt-3 block text-xs font-medium text-text-secondary">Timezone</label>
                <input id="nr-tz" value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} placeholder="America/New_York" className={inputClass} />
                {showErrors && <FieldError message={errors.timezone} />}
              </div>

              <div className="rounded-lg border border-border bg-bg-primary p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-text-primary">Escalate if nobody acknowledges</p>
                    <p className="text-xs text-text-secondary">Uses the tiers from your On-Call page. Recipients get an “Acknowledge” link.</p>
                  </div>
                  <Toggle
                    checked={draft.escalate_if_unacked}
                    onChange={(v) => setDraft({ ...draft, escalate_if_unacked: v, schedule_id: draft.schedule_id || (v ? schedules[0]?.id ?? '' : '') })}
                    label="Escalate if nobody acknowledges"
                  />
                </div>
                {(draft.escalate_if_unacked || draft.target_type === 'on_call') && (
                  <>
                    <select aria-label="On-call schedule" value={draft.schedule_id} onChange={(e) => setDraft({ ...draft, schedule_id: e.target.value })} className={`${inputClass} mt-3`}>
                      <option value="">Choose a schedule…</option>
                      {schedules.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.tierCount} tier{s.tierCount === 1 ? '' : 's'})</option>)}
                    </select>
                    {schedules.length === 0 && <p className="mt-1 text-xs text-warning-500">No schedule yet — create one on the On-Call Rotation page first.</p>}
                    {draft.escalate_if_unacked && selectedSchedule && selectedSchedule.tierCount === 0 && <p className="mt-1 text-xs text-warning-500">This schedule has no escalation tiers, so nothing would escalate. Add tiers on the On-Call page.</p>}
                    {showErrors && <FieldError message={errors.schedule} />}
                  </>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="nr-cool" className="mb-1 block text-xs font-medium text-text-secondary">Cooldown (minutes) — stay quiet after firing</label>
                  <input id="nr-cool" type="number" min={0} max={1440} value={Number.isFinite(draft.cooldown_minutes) ? draft.cooldown_minutes : ''} onChange={(e) => setDraft({ ...draft, cooldown_minutes: e.target.value === '' ? Number.NaN : Number(e.target.value) })} className={inputClass} />
                  {showErrors && <FieldError message={errors.cooldown} />}
                </div>
                <div>
                  <label htmlFor="nr-prio" className="mb-1 block text-xs font-medium text-text-secondary">Priority (lower runs first)</label>
                  <input id="nr-prio" type="number" min={0} max={10000} value={Number.isFinite(draft.priority) ? draft.priority : ''} onChange={(e) => setDraft({ ...draft, priority: e.target.value === '' ? Number.NaN : Number(e.target.value) })} className={inputClass} />
                  {showErrors && <FieldError message={errors.priority} />}
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className={btnGhost} onClick={() => setDraft(null)}>Cancel</button>
              <button type="button" className={btnPrimary} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save rule'}</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this rule?"
        description={`“${toDelete?.name ?? ''}” will stop routing alerts. Past deliveries stay in the log.`}
        confirmLabel="Yes, delete rule"
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
      />
    </DashboardLayout>
  );
}
