import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Code2, Copy, MessageCircle, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { ChatWidgetPreview, type PreviewState, type PreviewTheme } from '@/components/chatWidget/ChatWidgetPreview';
import {
  DAY_LABELS,
  DAY_ORDER,
  LIMITS,
  buildDefaults,
  buildEmbedSnippet,
  friendlySaveError,
  hasErrors,
  normalizeSettings,
  parseDomains,
  scheduleSummary,
  settingsEqual,
  validateSettings,
  type ChatWidgetRow,
  type ChatWidgetSettings,
  type DayHours,
} from '@/lib/chatWidget';
import {
  fetchAssigneeOptions,
  fetchChatWidget,
  fetchWidgetActivity,
  rotateChatWidgetKey,
  saveChatWidget,
  type AssigneeOption,
  type WidgetActivity,
} from '@/lib/chatWidgetApi';

const LABEL = 'Chat Widget';
const inputCls = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary disabled:opacity-60';
const labelCls = 'mb-1 block text-xs font-medium text-text-secondary';

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-text-secondary">{hint}</p>
      ) : null}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, disabled, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-xl border border-border bg-bg-primary p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`focus-ring rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 ${value === o.value ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

export function ChatWidgetSettingsPage() {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canManage = isOwner || permissions.can_edit_business_profile;

  const [row, setRow] = useState<ChatWidgetRow | null>(null);
  const [draft, setDraft] = useState<ChatWidgetSettings>(() => buildDefaults());
  const [domainsText, setDomainsText] = useState('');
  const [assignees, setAssignees] = useState<AssigneeOption[]>([]);
  const [activity, setActivity] = useState<WidgetActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewState, setPreviewState] = useState<PreviewState>('online');
  const [previewTheme, setPreviewTheme] = useState<PreviewTheme>('light');
  const [submitted, setSubmitted] = useState(false);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const [existing, team, act] = await Promise.all([
        fetchChatWidget(accountOwnerId),
        fetchAssigneeOptions(accountOwnerId).catch(() => [] as AssigneeOption[]),
        fetchWidgetActivity(accountOwnerId).catch(() => null),
      ]);
      const base = normalizeSettings(existing);
      setRow(existing);
      setDraft(base);
      setDomainsText(base.allowed_domains.join('\n'));
      setAssignees(team);
      setActivity(act);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => {
    load();
  }, [load]);

  const saved = useMemo(() => normalizeSettings(row), [row]);
  const parsedDomains = useMemo(() => parseDomains(domainsText), [domainsText]);
  const effective = useMemo<ChatWidgetSettings>(() => ({ ...draft, allowed_domains: parsedDomains.domains }), [draft, parsedDomains.domains]);
  const errors = useMemo(() => {
    const e = validateSettings(effective);
    if (parsedDomains.invalid.length) e.allowed_domains = `Not a valid domain: ${parsedDomains.invalid.slice(0, 3).join(', ')}`;
    return e;
  }, [effective, parsedDomains.invalid]);
  const dirty = row === null ? true : !settingsEqual(effective, saved);
  const showErr = (k: keyof typeof errors) => (submitted ? errors[k] : undefined);

  const patch = <K extends keyof ChatWidgetSettings>(key: K, value: ChatWidgetSettings[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const patchDay = (day: (typeof DAY_ORDER)[number], next: DayHours | null) =>
    setDraft((d) => {
      const schedule = { ...d.schedule };
      if (next) schedule[day] = next;
      else delete schedule[day];
      return { ...d, schedule };
    });

  const snippet = useMemo(() => {
    if (!row) return '';
    return buildEmbedSnippet({
      origin: window.location.origin,
      publicKey: row.public_key,
      supabaseUrl: (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '',
      supabaseAnonKey: (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '',
    });
  }, [row]);

  const handleSave = async () => {
    setSubmitted(true);
    if (!accountOwnerId || hasErrors(errors)) {
      toast('Fix the highlighted fields first.', 'error');
      return;
    }
    setSaving(true);
    try {
      const next = await saveChatWidget(accountOwnerId, effective);
      setRow(next);
      setDraft(normalizeSettings(next));
      setDomainsText(next.allowed_domains.join('\n'));
      setSubmitted(false);
      toast('Chat widget saved.', 'success');
    } catch (err) {
      toast(friendlySaveError(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Copy failed — select the snippet and copy it manually.', 'error');
    }
  };

  const handleRotate = async () => {
    if (!window.confirm('Generate a new install key? The snippet currently on your website will stop working until you replace it.')) return;
    setRotating(true);
    try {
      const key = await rotateChatWidgetKey();
      setRow((r) => (r ? { ...r, public_key: key, last_seen_at: null, last_seen_host: null } : r));
      toast('New key generated — update the snippet on your website.', 'success');
    } catch (err) {
      toast(friendlySaveError(err, 'Could not rotate the key.'), 'error');
    } finally {
      setRotating(false);
    }
  };

  if (!canManage) {
    return (
      <DashboardLayout activeLabel={LABEL}>
        <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <ShieldAlert className="mx-auto mb-3 text-text-secondary" size={28} />
          <h3 className="text-lg font-semibold text-text-primary">Access restricted</h3>
          <p className="mt-1.5 text-sm text-text-secondary">You need the “Edit business profile” permission to configure the chat widget. Ask your account owner.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel={LABEL}>
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
          <MessageCircle size={22} /> Website Chat Widget
        </h1>
        <p className="mt-1 text-sm text-text-secondary">Customize the chat bubble, set your hours and routing, then paste one snippet on your website.</p>
      </div>

      {loading ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]" aria-busy="true" aria-label="Loading chat widget settings">
          <div className="space-y-4">{[0, 1, 2].map((i) => <div key={i} className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />)}</div>
          <div className="h-[460px] animate-pulse rounded-2xl bg-bg-tertiary" />
        </div>
      ) : loadError ? (
        <div role="alert" className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
          <AlertTriangle className="mx-auto mb-3 text-warning-500" size={28} />
          <h3 className="text-lg font-semibold text-text-primary">Couldn’t load your chat widget</h3>
          <p className="mt-1.5 text-sm text-text-secondary">Check your connection and try again.</p>
          <button type="button" onClick={load} className="focus-ring mt-4 inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90">
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <div className="min-w-0 space-y-6">
            <Card className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-text-primary">Widget status</h2>
                  <p className="mt-0.5 text-xs text-text-secondary">
                    {row === null ? 'Not set up yet — save once to generate your install snippet.' : draft.enabled ? 'Live: visitors on your allowed domains can see the widget.' : 'Disabled: the widget is hidden everywhere.'}
                  </p>
                </div>
                <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-text-primary">
                  <input type="checkbox" role="switch" checked={draft.enabled} onChange={(e) => patch('enabled', e.target.checked)} className="h-4 w-4 rounded border-border" />
                  Enabled
                </label>
              </div>
            </Card>

            <Card className="space-y-4 p-5">
              <h2 className="text-sm font-semibold text-text-primary">Appearance</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Brand color" error={showErr('brand_color')}>
                  <div className="flex items-center gap-2">
                    <input type="color" aria-label="Pick brand color" value={/^#[0-9a-fA-F]{6}$/.test(draft.brand_color) ? draft.brand_color : '#3448E8'} onChange={(e) => patch('brand_color', e.target.value.toUpperCase())} className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-border bg-bg-primary p-1" />
                    <input value={draft.brand_color} onChange={(e) => patch('brand_color', e.target.value.trim())} maxLength={7} className={inputCls} />
                  </div>
                </Field>
                <Field label="Window title" error={showErr('title')}>
                  <input value={draft.title} maxLength={LIMITS.title} onChange={(e) => patch('title', e.target.value)} className={inputCls} />
                </Field>
                <Field label="Position">
                  <Segmented label="Position" value={draft.position} onChange={(v) => patch('position', v)} options={[{ value: 'right', label: 'Bottom right' }, { value: 'left', label: 'Bottom left' }]} />
                </Field>
                <Field label="Theme" hint="“Auto” follows each visitor's device setting.">
                  <Segmented label="Theme" value={draft.theme} onChange={(v) => patch('theme', v)} options={[{ value: 'auto', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
                </Field>
              </div>
              <Field label="Greeting (while online)" error={showErr('greeting')} hint={`${draft.greeting.length}/${LIMITS.greeting}`}>
                <textarea rows={2} value={draft.greeting} maxLength={LIMITS.greeting} onChange={(e) => patch('greeting', e.target.value)} className={inputCls} />
              </Field>
              <Field label="Message while offline" error={showErr('offline_message')} hint={`${draft.offline_message.length}/${LIMITS.offline}`}>
                <textarea rows={2} value={draft.offline_message} maxLength={LIMITS.offline} onChange={(e) => patch('offline_message', e.target.value)} className={inputCls} />
              </Field>
            </Card>

            <Card className="space-y-4 p-5">
              <h2 className="text-sm font-semibold text-text-primary">Business hours</h2>
              <Segmented label="Hours" value={draft.hours_mode} onChange={(v) => patch('hours_mode', v)} options={[{ value: 'always', label: 'Always online' }, { value: 'scheduled', label: 'Set weekly hours' }]} />
              {draft.hours_mode === 'scheduled' && (
                <>
                  <Field label="Time zone" error={showErr('timezone')} hint="IANA name, e.g. America/Chicago. Hours are evaluated in this zone for every visitor.">
                    <input value={draft.timezone} onChange={(e) => patch('timezone', e.target.value.trim())} className={inputCls} />
                  </Field>
                  <div className="space-y-2">
                    {DAY_ORDER.map((d) => {
                      const day = draft.schedule[d];
                      return (
                        <div key={d} className="flex flex-wrap items-center gap-2 text-sm">
                          <label className="flex w-28 shrink-0 items-center gap-2 text-text-primary">
                            <input type="checkbox" checked={!!day} onChange={(e) => patchDay(d, e.target.checked ? { open: '09:00', close: '17:00' } : null)} className="h-3.5 w-3.5 rounded border-border" />
                            {DAY_LABELS[Number(d)]}
                          </label>
                          {day ? (
                            <>
                              <input type="time" aria-label={`${DAY_LABELS[Number(d)]} opens`} value={day.open} onChange={(e) => patchDay(d, { ...day, open: e.target.value })} className={`${inputCls} w-auto`} />
                              <span className="text-text-secondary">to</span>
                              <input type="time" aria-label={`${DAY_LABELS[Number(d)]} closes`} value={day.close} onChange={(e) => patchDay(d, { ...day, close: e.target.value })} className={`${inputCls} w-auto`} />
                            </>
                          ) : (
                            <span className="text-xs text-text-secondary">Closed</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {showErr('schedule') && <p role="alert" className="text-xs text-danger">{errors.schedule}</p>}
                </>
              )}
            </Card>

            <Card className="space-y-4 p-5">
              <h2 className="text-sm font-semibold text-text-primary">Routing</h2>
              <Field label="Where do messages go?">
                <Segmented label="Routing" value={draft.routing_mode} onChange={(v) => patch('routing_mode', v)} options={[{ value: 'team_inbox', label: 'Shared team inbox' }, { value: 'assigned_member', label: 'Assign to one person' }]} />
              </Field>
              {draft.routing_mode === 'assigned_member' && (
                <Field label="Assigned team member" error={showErr('assigned_team_member_id')} hint={assignees.length === 0 ? 'No active team members yet — invite someone on the Team page.' : undefined}>
                  <select value={draft.assigned_team_member_id ?? ''} onChange={(e) => patch('assigned_team_member_id', e.target.value || null)} className={inputCls}>
                    <option value="">Select…</option>
                    {assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </Field>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="When offline">
                  <select value={draft.offline_behavior} onChange={(e) => patch('offline_behavior', e.target.value as ChatWidgetSettings['offline_behavior'])} className={inputCls}>
                    <option value="collect_lead">Collect a message</option>
                    <option value="show_message">Show message only</option>
                    <option value="hide">Hide the widget</option>
                  </select>
                </Field>
                <Field label="Ask visitors for">
                  <select value={draft.contact_field} onChange={(e) => patch('contact_field', e.target.value as ChatWidgetSettings['contact_field'])} className={inputCls}>
                    <option value="email">Email (required)</option>
                    <option value="phone">Phone (required)</option>
                    <option value="either">Email or phone</option>
                    <option value="none">Nothing</option>
                  </select>
                </Field>
              </div>
            </Card>

            <Card className="space-y-3 p-5">
              <h2 className="text-sm font-semibold text-text-primary">Allowed websites</h2>
              <Field label="Domains (one per line)" error={showErr('allowed_domains')} hint="Leave empty to allow any site. A domain also covers its subdomains. Best-effort protection — the install key is public.">
                <textarea rows={3} value={domainsText} onChange={(e) => setDomainsText(e.target.value)} placeholder="yourcompany.com" className={`${inputCls} font-mono`} />
              </Field>
            </Card>

            <div className="sticky bottom-3 z-10 flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary/95 px-4 py-3 shadow-card backdrop-blur">
              <p className="text-xs text-text-secondary" aria-live="polite">{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</p>
              <button type="button" onClick={handleSave} disabled={saving || !dirty} className="focus-ring rounded-xl bg-accent px-5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40">
                {saving ? 'Saving…' : row === null ? 'Create widget' : 'Save changes'}
              </button>
            </div>
          </div>

          <div className="min-w-0 space-y-6 lg:sticky lg:top-4 lg:self-start">
            <Card className="space-y-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-text-primary">Live preview</h2>
                <div className="flex gap-2">
                  <Segmented label="Preview state" value={previewState} onChange={setPreviewState} options={[{ value: 'online', label: 'Online' }, { value: 'offline', label: 'Offline' }]} />
                  <Segmented label="Preview theme" value={previewTheme} onChange={setPreviewTheme} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
                </div>
              </div>
              <ChatWidgetPreview settings={effective} state={previewState} theme={previewTheme} businessName={profile?.company_name} />
              {draft.hours_mode === 'scheduled' && <p className="text-xs text-text-secondary">{scheduleSummary(draft.schedule)} ({draft.timezone})</p>}
            </Card>

            <Card className="space-y-3 p-5">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary"><Code2 size={15} /> Install</h2>
              {row === null ? (
                <p className="text-sm text-text-secondary">Click “Create widget” to generate your install snippet.</p>
              ) : (
                <>
                  <p className="text-xs text-text-secondary">Paste this just before the closing <code className="rounded bg-bg-tertiary px-1">&lt;/body&gt;</code> tag on every page.</p>
                  <pre className="max-h-48 overflow-auto rounded-xl border border-border bg-bg-primary p-3 text-[11px] leading-relaxed text-text-primary"><code>{snippet}</code></pre>
                  {dirty && <p className="text-xs text-warning-500">Save your changes — the snippet always uses your last saved settings.</p>}
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={handleCopy} className="focus-ring inline-flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-xs font-medium text-white hover:opacity-90">
                      {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy snippet'}
                    </button>
                    <button type="button" onClick={handleRotate} disabled={rotating} className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border px-3.5 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50">
                      <RefreshCw size={14} className={rotating ? 'animate-spin' : ''} /> {rotating ? 'Rotating…' : 'Rotate key'}
                    </button>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-bg-primary px-3 py-2 text-xs text-text-secondary" aria-live="polite">
                    {row.last_seen_at ? (
                      <>Installed — last seen on <span className="font-medium text-text-primary">{row.last_seen_host}</span> {timeAgo(row.last_seen_at)}.</>
                    ) : (
                      'Not detected yet — it appears here after the first page load with the snippet.'
                    )}
                    {activity && <> {activity.last7Days} message{activity.last7Days === 1 ? '' : 's'} in the last 7 days.</>}
                  </div>
                </>
              )}
            </Card>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
