import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, Check, Code2, Copy, FlaskConical, Hash, PhoneCall, Plus, RefreshCw, Route, ShieldAlert, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Card } from '@/components/ui/Card';
import {
  FIELD_LABELS,
  LIMITS,
  MATCH_FIELDS,
  MATCH_OPS,
  OP_LABELS,
  buildSnippet,
  formatCount,
  formatPercent,
  formatPhone,
  friendlyError,
  hasErrors,
  parseSignalsFromUrl,
  poolHealth,
  readinessIssues,
  relativeTime,
  slugifySourceKey,
  sourceLabel,
  sourceOptions,
  summarizePerformance,
  validateNumber,
  validateRule,
  validateSettings,
  type ClassificationPreview,
  type DniNumberRow,
  type DniPerformance,
  type DniRuleRow,
  type DniSettingsRow,
  type MatchField,
  type MatchOp,
  type NumberDraft,
  type RuleDraft,
  type SettingsDraft,
} from '@/lib/dynamicNumbers';
import {
  addNumber,
  addRule,
  deleteNumber,
  deleteRule,
  fetchNumbers,
  fetchPerformance,
  fetchRules,
  fetchSettings,
  previewClassification,
  rotateKey,
  saveSettings,
  setNumberActive,
  setRuleEnabled,
} from '@/lib/dynamicNumbersApi';

const LABEL = 'Call Tracking';
const inputCls = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary disabled:opacity-60';
const labelCls = 'mb-1 block text-xs font-medium text-text-secondary';
const btnPrimary = 'focus-ring inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50';
const btnGhost = 'focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50';
const PERIODS = [7, 30, 90] as const;

const EMPTY_NUMBER: NumberDraft = { kind: 'pool', phone: '', sourceKey: 'google_ads', label: '', vapiId: '' };
const EMPTY_RULE: RuleDraft = { field: 'utm_campaign', op: 'contains', value: '', sourceLabel: '', priority: 100 };

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
      {error ? <p role="alert" className="mt-1 text-xs text-danger">{error}</p> : hint ? <p className="mt-1 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

function Empty({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
      <div className="mx-auto mb-2 flex justify-center text-text-secondary">{icon}</div>
      <p className="text-sm font-medium text-text-primary">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-text-secondary">{body}</p>
    </div>
  );
}

export function DynamicNumbersPage() {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const owner = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canManage = isOwner || permissions.can_edit_business_profile;

  const [settings, setSettings] = useState<DniSettingsRow | null>(null);
  const [numbers, setNumbers] = useState<DniNumberRow[]>([]);
  const [rules, setRules] = useState<DniRuleRow[]>([]);
  const [perf, setPerf] = useState<DniPerformance | null>(null);
  const [perfError, setPerfError] = useState(false);
  const [perfLoading, setPerfLoading] = useState(false);
  const [days, setDays] = useState<number>(30);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [draft, setDraft] = useState<SettingsDraft>({ enabled: false, defaultNumber: '', domainsText: '', leaseMinutes: LIMITS.defaultLease });
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [requireConsent, setRequireConsent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);

  const [numDraft, setNumDraft] = useState<NumberDraft>(EMPTY_NUMBER);
  const [addingNumber, setAddingNumber] = useState(false);
  const [numSubmitted, setNumSubmitted] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<DniNumberRow | null>(null);

  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(EMPTY_RULE);
  const [addingRule, setAddingRule] = useState(false);
  const [ruleSubmitted, setRuleSubmitted] = useState(false);

  const [testUrl, setTestUrl] = useState('');
  const [testRef, setTestRef] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ClassificationPreview | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const hydrate = (s: DniSettingsRow | null) =>
    setDraft({
      enabled: s?.enabled ?? false,
      defaultNumber: s?.default_number ? formatPhone(s.default_number) : '',
      domainsText: (s?.allowed_domains ?? []).join('\n'),
      leaseMinutes: s?.lease_minutes ?? LIMITS.defaultLease,
    });

  const loadPerf = useCallback(async (d: number) => {
    setPerfLoading(true);
    setPerfError(false);
    try {
      setPerf(await fetchPerformance(d));
    } catch {
      setPerfError(true);
    } finally {
      setPerfLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    if (!owner) return;
    setLoading(true);
    setLoadError(false);
    try {
      const [s, n, r] = await Promise.all([fetchSettings(owner), fetchNumbers(owner), fetchRules(owner)]);
      setSettings(s);
      setNumbers(n);
      setRules(r);
      hydrate(s);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [owner]);

  useEffect(() => { if (canManage) void load(); else setLoading(false); }, [load, canManage]);
  useEffect(() => { if (canManage && owner) void loadPerf(days); }, [canManage, owner, days, loadPerf]);

  const errors = useMemo(() => validateSettings(draft), [draft]);
  const issues = useMemo(() => readinessIssues(settings, numbers), [settings, numbers]);
  const summary = useMemo(() => summarizePerformance(perf), [perf]);
  const health = useMemo(() => poolHealth(perf), [perf]);
  const options = useMemo(() => sourceOptions(rules), [rules]);
  const numErrors = useMemo(() => validateNumber(numDraft, numbers, settings?.default_number ?? null), [numDraft, numbers, settings]);
  const ruleErrors = useMemo(() => validateRule(ruleDraft, rules.length), [ruleDraft, rules.length]);

  const snippet = useMemo(
    () => settings ? buildSnippet({
      origin: typeof window !== 'undefined' ? window.location.origin : '',
      publicKey: settings.public_key,
      supabaseUrl: (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '',
      supabaseAnonKey: (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '',
      requireConsent,
    }) : '',
    [settings, requireConsent],
  );

  const handleSave = async () => {
    setSubmitted(true);
    if (!owner || hasErrors(errors)) { toast('Fix the highlighted fields first.', 'error'); return; }
    setSaving(true);
    try {
      const saved = await saveSettings(owner, draft);
      setSettings(saved);
      hydrate(saved);
      setSubmitted(false);
      toast('Call tracking settings saved.', 'success');
    } catch (err) {
      toast(friendlyError(err, 'Could not save your settings.'), 'error');
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
    setRotating(true);
    try {
      const key = await rotateKey();
      setSettings((s) => (s ? { ...s, public_key: key } : s));
      toast('New install key created. Update the snippet on your website.', 'success');
    } catch (err) {
      toast(friendlyError(err, 'Could not create a new key.'), 'error');
    } finally {
      setRotating(false);
    }
  };

  const handleAddNumber = async () => {
    setNumSubmitted(true);
    if (!owner || hasErrors(numErrors)) return;
    setBusyId('new-number');
    try {
      const row = await addNumber(owner, numDraft);
      setNumbers((n) => [...n, row]);
      setNumDraft(EMPTY_NUMBER);
      setNumSubmitted(false);
      setAddingNumber(false);
      toast('Tracking number added.', 'success');
      void loadPerf(days);
    } catch (err) {
      toast(friendlyError(err, 'Could not add this number.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleNumber = async (n: DniNumberRow) => {
    if (!owner) return;
    setBusyId(n.id);
    try {
      await setNumberActive(owner, n.id, !n.active);
      setNumbers((list) => list.map((x) => (x.id === n.id ? { ...x, active: !n.active } : x)));
    } catch (err) {
      toast(friendlyError(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteNumber = async () => {
    if (!owner || !toDelete) return;
    const target = toDelete;
    try {
      await deleteNumber(owner, target.id);
      setNumbers((list) => list.filter((x) => x.id !== target.id));
      toast('Tracking number removed.', 'success');
      void loadPerf(days);
    } catch (err) {
      toast(friendlyError(err), 'error');
    } finally {
      setToDelete(null);
    }
  };

  const handleAddRule = async () => {
    setRuleSubmitted(true);
    if (!owner || hasErrors(ruleErrors)) return;
    setBusyId('new-rule');
    try {
      const row = await addRule(owner, ruleDraft);
      setRules((r) => [...r, row].sort((a, b) => a.priority - b.priority));
      setRuleDraft(EMPTY_RULE);
      setRuleSubmitted(false);
      setAddingRule(false);
      toast('Rule added.', 'success');
    } catch (err) {
      toast(friendlyError(err, 'Could not add this rule.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleRule = async (r: DniRuleRow) => {
    if (!owner) return;
    setBusyId(r.id);
    try {
      await setRuleEnabled(owner, r.id, !r.enabled);
      setRules((list) => list.map((x) => (x.id === r.id ? { ...x, enabled: !r.enabled } : x)));
    } catch (err) {
      toast(friendlyError(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteRule = async (r: DniRuleRow) => {
    if (!owner) return;
    setBusyId(r.id);
    try {
      await deleteRule(owner, r.id);
      setRules((list) => list.filter((x) => x.id !== r.id));
    } catch (err) {
      toast(friendlyError(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleTest = async () => {
    setTestResult(null);
    setTestError(null);
    const parsed = parseSignalsFromUrl(testUrl, testRef);
    if (!parsed) { setTestError('Enter a full page address, e.g. yoursite.com/ac-repair?utm_source=google&gclid=123'); return; }
    setTesting(true);
    try {
      setTestResult(await previewClassification(parsed.signals, parsed.host));
    } catch (err) {
      setTestError(friendlyError(err, 'Could not test this visit.'));
    } finally {
      setTesting(false);
    }
  };

  if (!canManage) {
    return (
      <DashboardLayout activeLabel={LABEL}>
        <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <ShieldAlert className="mx-auto mb-3 text-text-secondary" size={28} />
          <h3 className="text-lg font-semibold text-text-primary">Access restricted</h3>
          <p className="mt-1.5 text-sm text-text-secondary">You need the “Edit business profile” permission to manage call tracking. Ask your account owner.</p>
        </div>
      </DashboardLayout>
    );
  }

  const showErr = <K extends keyof typeof errors>(k: K) => (submitted ? errors[k] : undefined);
  const pool = numbers.filter((n) => n.kind === 'pool');
  const dedicated = numbers.filter((n) => n.kind === 'source');

  return (
    <DashboardLayout activeLabel={LABEL}>
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><PhoneCall size={22} /> Call Tracking</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Show each website visitor a phone number based on where they came from, and see which ads, listings and campaigns actually make the phone ring.
        </p>
      </div>

      {loading ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading call tracking">
          {[0, 1, 2].map((i) => <div key={i} className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />)}
        </div>
      ) : loadError ? (
        <div role="alert" className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
          <AlertTriangle className="mx-auto mb-3 text-warning-500" size={28} />
          <h3 className="text-lg font-semibold text-text-primary">Couldn’t load call tracking</h3>
          <p className="mt-1.5 text-sm text-text-secondary">Check your connection and try again.</p>
          <button type="button" onClick={load} className={`${btnPrimary} mt-4`}><RefreshCw size={14} /> Retry</button>
        </div>
      ) : (
        <div className="space-y-6">
          {issues.length > 0 && (
            <ul className="space-y-1 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-xs text-text-primary" aria-live="polite">
              {issues.map((i) => <li key={i} className="flex gap-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning-500" />{i}</li>)}
            </ul>
          )}

          {/* 1 · Setup */}
          <Card className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-text-primary">Setup</h2>
                <p className="mt-0.5 text-xs text-text-secondary">The script looks for your normal number on your pages and swaps it. Direct visitors always keep it.</p>
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" role="switch" aria-label="Enable call tracking" checked={draft.enabled}
                  onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))} className="h-4 w-4 rounded border-border" />
                Enabled
              </label>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Your normal business number" error={showErr('defaultNumber')} hint="Exactly as customers see it on your site today.">
                <input className={inputCls} inputMode="tel" placeholder="(555) 123-4567" value={draft.defaultNumber}
                  onChange={(e) => setDraft((d) => ({ ...d, defaultNumber: e.target.value }))} />
              </Field>
              <Field label="Keep a number for (minutes)" error={showErr('lease')} hint="How long a pool number stays reserved for a visitor after their last page view.">
                <input className={inputCls} type="number" min={LIMITS.minLease} max={LIMITS.maxLease} value={draft.leaseMinutes}
                  onChange={(e) => setDraft((d) => ({ ...d, leaseMinutes: Number(e.target.value) }))} />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Allowed websites (one per line)" error={showErr('domains')} hint="Leave empty to allow any site. A domain also covers its subdomains. Best-effort protection — the install key is public.">
                  <textarea className={`${inputCls} min-h-[80px] font-mono`} placeholder="yourcompany.com" value={draft.domainsText}
                    onChange={(e) => setDraft((d) => ({ ...d, domainsText: e.target.value }))} />
                </Field>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={handleSave} disabled={saving} className={btnPrimary}>
                <Check size={14} /> {saving ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          </Card>

          {/* 2 · Install */}
          <Card className="p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Code2 size={15} /> Install on your website</h2>
            {!settings ? (
              <p className="mt-2 text-xs text-text-secondary">Save your settings above to get your install snippet.</p>
            ) : (
              <>
                <p className="mt-0.5 text-xs text-text-secondary">
                  Paste this once, just before <code>&lt;/body&gt;</code> on every page. {settings.last_seen_at
                    ? <>Last seen on <strong>{settings.last_seen_host ?? 'your site'}</strong> {relativeTime(settings.last_seen_at)}.</>
                    : 'Not seen on a website yet.'}
                </p>
                <pre className="mt-3 overflow-x-auto rounded-xl border border-border bg-bg-primary p-3 text-xs text-text-primary" tabIndex={0}><code>{snippet}</code></pre>
                <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-text-secondary">
                  <input type="checkbox" checked={requireConsent} onChange={(e) => setRequireConsent(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-border" />
                  <span>Wait for cookie consent. Nothing is stored or sent until your banner calls <code>__vireekDNI.grantConsent()</code>; until then visitors see your normal number.</span>
                </label>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={handleCopy} className={btnPrimary}>{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy snippet'}</button>
                  <button type="button" onClick={handleRotate} disabled={rotating} className={btnGhost}><RefreshCw size={14} /> {rotating ? 'Creating…' : 'Create new key'}</button>
                </div>
                <p className="mt-3 text-xs text-text-secondary">
                  Phone number split across several elements, or built by JavaScript? Wrap it in <code>&lt;span data-vireek-number&gt;(555) 123-4567&lt;/span&gt;</code>.
                  Add <code>data-vireek-dni-ignore</code> to any element the script should leave alone.
                </p>
              </>
            )}
          </Card>

          {/* 3 · Numbers */}
          <Card className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Hash size={15} /> Tracking numbers</h2>
                <p className="mt-0.5 text-xs text-text-secondary">
                  <strong>Pool</strong> numbers are lent to one visitor at a time, so a call can be tied to that visitor’s campaign and page.{' '}
                  <strong>Dedicated</strong> numbers are shown to every visitor from one source.
                </p>
              </div>
              {!addingNumber && <button type="button" onClick={() => setAddingNumber(true)} className={btnGhost}><Plus size={14} /> Add number</button>}
            </div>

            <p className="mt-3 rounded-xl bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
              Each number must first be bought in Vapi and pointed at your Vireek assistant — adding it here only records it. Enter the Vapi phone number ID if you have it.
            </p>

            {addingNumber && (
              <div className="mt-3 rounded-xl border border-border bg-bg-primary p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Type">
                    <select className={inputCls} value={numDraft.kind} onChange={(e) => setNumDraft((d) => ({ ...d, kind: e.target.value as NumberDraft['kind'] }))}>
                      <option value="pool">Pool — matched to each visitor</option>
                      <option value="source">Dedicated — one source</option>
                    </select>
                  </Field>
                  {numDraft.kind === 'source' && (
                    <Field label="Source" error={numSubmitted ? numErrors.sourceKey : undefined}>
                      <select className={inputCls} value={numDraft.sourceKey} onChange={(e) => setNumDraft((d) => ({ ...d, sourceKey: e.target.value }))}>
                        {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                      </select>
                    </Field>
                  )}
                  <Field label="Phone number" error={numSubmitted ? numErrors.phone : undefined}>
                    <input className={inputCls} inputMode="tel" placeholder="(555) 987-6543" value={numDraft.phone} onChange={(e) => setNumDraft((d) => ({ ...d, phone: e.target.value }))} />
                  </Field>
                  <Field label="Vapi phone number ID (optional)" error={numSubmitted ? numErrors.vapiId : undefined}>
                    <input className={inputCls} value={numDraft.vapiId} onChange={(e) => setNumDraft((d) => ({ ...d, vapiId: e.target.value }))} />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="Note (optional)" error={numSubmitted ? numErrors.label : undefined}>
                      <input className={inputCls} maxLength={80} placeholder="e.g. Pool #1" value={numDraft.label} onChange={(e) => setNumDraft((d) => ({ ...d, label: e.target.value }))} />
                    </Field>
                  </div>
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <button type="button" className={btnGhost} onClick={() => { setAddingNumber(false); setNumSubmitted(false); setNumDraft(EMPTY_NUMBER); }}>Cancel</button>
                  <button type="button" className={btnPrimary} disabled={busyId === 'new-number'} onClick={handleAddNumber}><Check size={14} /> Save number</button>
                </div>
              </div>
            )}

            <div className="mt-4 space-y-2">
              {numbers.length === 0 ? (
                <Empty icon={<Hash size={22} />} title="No tracking numbers yet" body="Start with 3–5 pool numbers for paid traffic, or one dedicated number for a source such as Google Business Profile." />
              ) : (
                [...dedicated, ...pool].map((n) => (
                  <div key={n.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text-primary">{formatPhone(n.phone_e164)}</p>
                      <p className="truncate text-xs text-text-secondary">
                        {n.kind === 'pool' ? 'Pool' : `Dedicated · ${sourceLabel(n.source_key ?? '', rules)}`}
                        {n.label ? ` · ${n.label}` : ''}
                        {n.kind === 'pool' && n.lease_until && Date.parse(n.lease_until) > Date.now() ? ' · in use now' : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-text-secondary">
                        <input type="checkbox" role="switch" aria-label={`Active ${formatPhone(n.phone_e164)}`} checked={n.active} disabled={busyId === n.id}
                          onChange={() => handleToggleNumber(n)} className="h-4 w-4 rounded border-border" />
                        Active
                      </label>
                      <button type="button" onClick={() => setToDelete(n)} aria-label={`Remove ${formatPhone(n.phone_e164)}`}
                        className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger"><Trash2 size={14} /></button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>

          {/* 4 · Rules */}
          <Card className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Route size={15} /> Custom source rules</h2>
                <p className="mt-0.5 text-xs text-text-secondary">Optional. Checked first, lowest priority number wins. Without rules, Google/Bing ads, Google Business Profile, Facebook, email and referrers are recognised automatically.</p>
              </div>
              {!addingRule && <button type="button" onClick={() => setAddingRule(true)} className={btnGhost}><Plus size={14} /> Add rule</button>}
            </div>

            {addingRule && (
              <div className="mt-3 rounded-xl border border-border bg-bg-primary p-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="When">
                    <select className={inputCls} value={ruleDraft.field} onChange={(e) => setRuleDraft((d) => ({ ...d, field: e.target.value as MatchField }))}>
                      {MATCH_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
                    </select>
                  </Field>
                  <Field label="Condition">
                    <select className={inputCls} value={ruleDraft.op} onChange={(e) => setRuleDraft((d) => ({ ...d, op: e.target.value as MatchOp }))}>
                      {MATCH_OPS.map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
                    </select>
                  </Field>
                  {ruleDraft.op !== 'present' && (
                    <Field label="Text" error={ruleSubmitted ? ruleErrors.value : undefined}>
                      <input className={inputCls} placeholder="e.g. spring-promo" value={ruleDraft.value} onChange={(e) => setRuleDraft((d) => ({ ...d, value: e.target.value }))} />
                    </Field>
                  )}
                  <Field label="Count it as" error={ruleSubmitted ? ruleErrors.sourceLabel : undefined} hint={ruleDraft.sourceLabel ? `Key: ${slugifySourceKey(ruleDraft.sourceLabel) || '—'}` : undefined}>
                    <input className={inputCls} maxLength={60} placeholder="e.g. Spring Promo Mailer" value={ruleDraft.sourceLabel} onChange={(e) => setRuleDraft((d) => ({ ...d, sourceLabel: e.target.value }))} />
                  </Field>
                  <Field label="Priority" error={ruleSubmitted ? ruleErrors.priority : undefined} hint="1 is checked first.">
                    <input className={inputCls} type="number" min={1} max={1000} value={ruleDraft.priority} onChange={(e) => setRuleDraft((d) => ({ ...d, priority: Number(e.target.value) }))} />
                  </Field>
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <button type="button" className={btnGhost} onClick={() => { setAddingRule(false); setRuleSubmitted(false); setRuleDraft(EMPTY_RULE); }}>Cancel</button>
                  <button type="button" className={btnPrimary} disabled={busyId === 'new-rule'} onClick={handleAddRule}><Check size={14} /> Save rule</button>
                </div>
              </div>
            )}

            <div className="mt-4 space-y-2">
              {rules.length === 0 ? (
                <Empty icon={<Route size={22} />} title="No custom rules" body="Add one if a campaign uses its own tags — for example when utm_campaign contains “mailer”, count it as Direct Mail." />
              ) : rules.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary px-3 py-2">
                  <p className="min-w-0 text-sm text-text-primary">
                    <span className="text-text-secondary">#{r.priority} · </span>
                    {FIELD_LABELS[r.match_field]} {OP_LABELS[r.match_op]}{r.match_value ? <> <code>{r.match_value}</code></> : null} → <strong>{r.source_label}</strong>
                  </p>
                  <div className="flex items-center gap-3">
                    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-text-secondary">
                      <input type="checkbox" role="switch" aria-label={`Enabled ${r.source_label}`} checked={r.enabled} disabled={busyId === r.id}
                        onChange={() => handleToggleRule(r)} className="h-4 w-4 rounded border-border" /> On
                    </label>
                    <button type="button" onClick={() => handleDeleteRule(r)} disabled={busyId === r.id} aria-label={`Remove rule ${r.source_label}`}
                      className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger"><Trash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* 5 · Test a visit */}
          <Card className="p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><FlaskConical size={15} /> Test a visit</h2>
            <p className="mt-0.5 text-xs text-text-secondary">Paste a page address (with its tags) to see which source it counts as and what number a visitor would get. Nothing is saved.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
              <Field label="Page address"><input className={inputCls} placeholder="yoursite.com/ac-repair?utm_source=google&gclid=123" value={testUrl} onChange={(e) => setTestUrl(e.target.value)} /></Field>
              <Field label="Came from (optional)"><input className={inputCls} placeholder="google.com" value={testRef} onChange={(e) => setTestRef(e.target.value)} /></Field>
              <button type="button" onClick={handleTest} disabled={testing || !testUrl.trim()} className={btnPrimary}>{testing ? 'Testing…' : 'Test'}</button>
            </div>
            {testError && <p role="alert" className="mt-2 text-xs text-danger">{testError}</p>}
            {testResult && (
              <p className="mt-3 rounded-xl bg-bg-tertiary px-3 py-2 text-sm text-text-primary" aria-live="polite">
                Counts as <strong>{testResult.source_label}</strong>.{' '}
                {testResult.number_mode === 'source' ? <>Visitor sees the dedicated number <strong>{formatPhone(testResult.dedicated_number)}</strong>.</>
                  : testResult.number_mode === 'pool' ? <>Visitor gets a pool number matched to this visit.</>
                  : <>Visitor keeps your normal number (no tracking number applies).</>}
              </p>
            )}
          </Card>

          {/* 6 · Performance */}
          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><BarChart3 size={15} /> Which sources make the phone ring</h2>
              <div role="group" aria-label="Period" className="flex gap-1">
                {PERIODS.map((p) => (
                  <button key={p} type="button" aria-pressed={days === p} onClick={() => setDays(p)}
                    className={`focus-ring rounded-lg border px-3 py-1 text-xs ${days === p ? 'border-accent bg-accent/10 text-text-primary' : 'border-border text-text-secondary hover:text-text-primary'}`}>{p} days</button>
                ))}
              </div>
            </div>

            {perfLoading && !perf ? (
              <div className="mt-4 h-32 animate-pulse rounded-xl bg-bg-tertiary" aria-busy="true" />
            ) : perfError ? (
              <div role="alert" className="mt-4 rounded-xl border border-dashed border-border px-4 py-8 text-center">
                <p className="text-sm text-text-primary">Couldn’t load the results.</p>
                <button type="button" onClick={() => loadPerf(days)} className={`${btnGhost} mt-3`}><RefreshCw size={14} /> Retry</button>
              </div>
            ) : summary.rows.length === 0 ? (
              <div className="mt-4"><Empty icon={<BarChart3 size={22} />} title="No tracked visits or calls yet" body="Once the snippet is live and a tracking number is added, visits and calls appear here by source." /></div>
            ) : (
              <>
                <div className="mt-4 grid grid-cols-3 gap-3 text-center">
                  {[['Visits tracked', formatCount(summary.sessions)], ['Calls', formatCount(summary.calls)], ['Calls per visit', formatPercent(summary.callRate)]].map(([k, v]) => (
                    <div key={k} className="rounded-xl bg-bg-tertiary px-2 py-3"><p className="text-lg font-bold text-text-primary">{v}</p><p className="text-xs text-text-secondary">{k}</p></div>
                  ))}
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[420px] text-left text-sm">
                    <thead className="text-xs text-text-secondary"><tr><th className="py-2 pr-3 font-medium">Source</th><th className="px-3 font-medium">Visits</th><th className="px-3 font-medium">Calls</th><th className="px-3 font-medium">Calls per visit</th><th className="pl-3 font-medium">Last call</th></tr></thead>
                    <tbody>
                      {summary.rows.map((r) => (
                        <tr key={r.source_key} className="border-t border-border/60">
                          <td className="py-2 pr-3 font-medium text-text-primary">{r.source_label}
                            <div className="mt-1 h-1.5 w-full max-w-[160px] rounded-full bg-bg-tertiary" aria-hidden="true"><div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.max(2, Math.round(r.sessionShare * 100))}%` }} /></div>
                          </td>
                          <td className="px-3 text-text-primary">{formatCount(r.sessions)}</td>
                          <td className="px-3 text-text-primary">{formatCount(r.calls)}</td>
                          <td className="px-3 text-text-primary">{formatPercent(r.callRate)}</td>
                          <td className="pl-3 text-text-secondary">{relativeTime(r.last_call_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <p role="status" className={`mt-4 flex gap-1.5 rounded-xl px-3 py-2 text-xs ${health.level === 'danger' ? 'bg-danger/10 text-danger' : health.level === 'warn' ? 'bg-warning-500/10 text-text-primary' : 'bg-bg-tertiary text-text-secondary'}`}>
              {(health.level === 'danger' || health.level === 'warn') && <AlertTriangle size={13} className="mt-0.5 shrink-0" />}{health.message}
            </p>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={!!toDelete}
        title="Remove this tracking number?"
        description={`${formatPhone(toDelete?.phone_e164)} will stop being shown to visitors. Past calls keep their source. This does not cancel the number in Vapi.`}
        confirmLabel="Yes, remove it"
        onConfirm={handleDeleteNumber}
        onCancel={() => setToDelete(null)}
      />
    </DashboardLayout>
  );
}
