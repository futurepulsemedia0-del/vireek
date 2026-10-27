import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Pause, Phone, PhoneCall, PhoneOutgoing, Play, Plus, RefreshCw, SkipForward, TriangleAlert, Upload, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import { formatPhone, telHref } from '@/lib/callMasking';
import {
  CAMPAIGN_STATUS_LABELS, DEFAULT_FORM, DISPOSITIONS, SKIP_DEFER_MINUTES, contactRate, dispositionByHotkey, formFromCampaign,
  nextCampaignStatuses, parseImportText, progressPercent, secondsUntil, validateCampaignForm, DISPOSITION_LABELS,
  type CallerIdOption, type CampaignForm, type CampaignStatus, type DialerCampaign, type DialerContact, type DialerStats, type Disposition, type DispositionRule,
} from '@/lib/powerDialer';
import {
  WrapUpError, claimNext, completeAttempt, createCampaign, deferContact, fetchCallerIds, fetchCampaign, fetchCampaigns, fetchRecentContacts,
  fetchStats, importContacts, importFromCrm, placeCall, setCampaignStatus, updateCampaign,
} from '@/lib/powerDialerApi';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary focus-visible:border-accent';

const TONE: Record<DispositionRule['tone'], string> = {
  good: 'border-success-500/40 text-success-500 hover:bg-success-500/10',
  warn: 'border-warning-500/40 text-warning-500 hover:bg-warning-500/10',
  bad: 'border-danger/40 text-danger hover:bg-danger/10',
  neutral: 'border-border text-text-primary hover:bg-bg-tertiary',
};

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref as React.RefObject<HTMLDivElement>} role="dialog" aria-modal="true" aria-label={title}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 sm:max-w-lg sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-text-primary">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- campaign form
function CampaignDialog({ ownerId, campaign, callerIds, onClose, onSaved }: {
  ownerId: string; campaign: DialerCampaign | null; callerIds: CallerIdOption[]; onClose: () => void; onSaved: (c: DialerCampaign) => void;
}) {
  const [form, setForm] = useState<CampaignForm>(campaign ? formFromCampaign(campaign) : DEFAULT_FORM);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof CampaignForm>(k: K, v: CampaignForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const num = (k: keyof CampaignForm) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validateCampaignForm(form);
    if (problem) return setError(problem);
    setSaving(true);
    setError(null);
    try {
      onSaved(campaign ? await updateCampaign(campaign.id, form) : await createCampaign(ownerId, form));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={campaign ? 'Campaign settings' : 'New campaign'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Input label="Name" value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={120} autoComplete="off" />
        <Textarea label="Description (optional)" rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={500} />
        <div>
          <label htmlFor="pd-caller" className="mb-1.5 block text-sm font-medium text-text-primary">Caller ID</label>
          <select id="pd-caller" className={selectClass} value={form.phone_number_id} onChange={(e) => set('phone_number_id', e.target.value)}>
            <option value="">Choose a number…</option>
            {callerIds.map((c) => <option key={c.id} value={c.id}>{c.friendly_name} · {formatPhone(c.phone_number)}</option>)}
          </select>
          {callerIds.length === 0 && <p className="mt-1.5 text-xs text-text-secondary">No active voice numbers found. Add one under Phone Numbers.</p>}
        </div>
        <div>
          <label htmlFor="pd-mode" className="mb-1.5 block text-sm font-medium text-text-primary">Pacing</label>
          <select id="pd-mode" className={selectClass} value={form.pacing_mode} onChange={(e) => set('pacing_mode', e.target.value as CampaignForm['pacing_mode'])}>
            <option value="power">Power: dial the next contact automatically</option>
            <option value="preview">Preview: agent presses Call</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Preview (seconds)" type="number" min={0} max={60} value={form.preview_seconds} onChange={num('preview_seconds')} />
          <Input label="Wrap-up (seconds)" type="number" min={0} max={300} value={form.wrap_up_seconds} onChange={num('wrap_up_seconds')} />
          <Input label="Attempts per contact" type="number" min={1} max={10} value={form.max_attempts} onChange={num('max_attempts')} />
          <Input label="Retry after (minutes)" type="number" min={5} max={10080} value={form.retry_minutes} onChange={num('retry_minutes')} />
          <Input label="Calls per hour (per agent)" type="number" min={1} max={600} value={form.max_calls_per_hour} onChange={num('max_calls_per_hour')} />
        </div>
        <Textarea label="Call script (optional)" rows={4} value={form.script} onChange={(e) => set('script', e.target.value)} maxLength={4000} />
        {error && <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} {campaign ? 'Save' : 'Create campaign'}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- import
function ImportDialog({ campaignId, onClose, onDone }: { campaignId: string; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseImportText(text), [text]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return setError('That file is too large (2 MB max).');
    setText(await file.text());
  };

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      toast(await fn(), 'success');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add contacts" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <Textarea label="Paste a list: name, phone, notes (one per line)" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Ann Lee, (555) 201-0001\nBob Cruz, 555-201-0002, prefers mornings'} />
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-text-secondary">
            <label className="focus-ring inline-flex min-h-[40px] cursor-pointer items-center gap-1.5 rounded-xl border border-border px-3 font-medium text-text-primary hover:bg-bg-tertiary">
              <Upload size={14} aria-hidden="true" /> Upload CSV
              <input type="file" accept=".csv,.txt,text/csv,text/plain" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
            </label>
            <span>{parsed.rows.length} rows ready{parsed.skipped > 0 ? ` · ${parsed.skipped} skipped` : ''}{parsed.tooMany ? ' · only the first 5,000 are used' : ''}</span>
          </div>
          <Button className="mt-3" disabled={busy || parsed.rows.length === 0} onClick={() => void run(async () => {
            const r = await importContacts(campaignId, parsed.rows);
            return `${r.inserted} added · ${r.duplicates} duplicates · ${r.invalid} invalid · ${r.suppressed} on do-not-call`;
          })}>
            {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Import list
          </Button>
        </div>
        <div className="border-t border-border pt-4">
          <p className="mb-2 text-sm font-medium text-text-primary">Or add from your CRM</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(async () => `${await importFromCrm(campaignId, 'customers')} customers added`)}>All customers</Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(async () => `${await importFromCrm(campaignId, 'customers', 'inactive')} customers added`)}>Inactive customers</Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(async () => `${await importFromCrm(campaignId, 'leads')} leads added`)}>All leads</Button>
          </div>
          <p className="mt-2 text-xs text-text-secondary">Numbers on your do-not-call list are never added.</p>
        </div>
        {error && <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- console
type Phase = 'loading' | 'wrap' | 'empty' | 'ready' | 'error';

function Console({ campaign, onChanged }: { campaign: DialerCampaign; onChanged: () => void }) {
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>('loading');
  const [contact, setContact] = useState<DialerContact | null>(null);
  const [wrapUntil, setWrapUntil] = useState(0);
  const [previewUntil, setPreviewUntil] = useState(0);
  const [tick, setTick] = useState(Date.now());
  const [autoDial, setAutoDial] = useState(campaign.pacing_mode === 'power');
  const [dialing, setDialing] = useState(false);
  const [dialed, setDialed] = useState(false);
  const [manualDial, setManualDial] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [callbackAt, setCallbackAt] = useState('');
  const [needCallback, setNeedCallback] = useState(false);
  const [errorText, setErrorText] = useState('');
  const busyRef = useRef(false);

  const next = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setErrorText('');
    try {
      const c = await claimNext(campaign.id);
      setNote(''); setCallbackAt(''); setNeedCallback(false); setDialed(false); setManualDial(false);
      if (!c) { setContact(null); setPhase('empty'); return; }
      setContact(c);
      setPhase('ready');
      setPreviewUntil(Date.now() + campaign.preview_seconds * 1000);
    } catch (err) {
      if (err instanceof WrapUpError) { setContact(null); setWrapUntil(Date.now() + err.seconds * 1000); setPhase('wrap'); }
      else { setErrorText(err instanceof Error ? err.message : 'Something went wrong.'); setPhase('error'); }
    } finally {
      busyRef.current = false;
    }
  }, [campaign.id, campaign.preview_seconds]);

  useEffect(() => { void next(); }, [next]);

  useEffect(() => {
    if (phase !== 'wrap' && phase !== 'ready') return;
    const id = window.setInterval(() => setTick(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [phase]);

  const wrapLeft = secondsUntil(wrapUntil, tick);
  useEffect(() => { if (phase === 'wrap' && wrapLeft === 0) void next(); }, [phase, wrapLeft, next]);

  const dial = useCallback(async () => {
    if (!contact || dialing || dialed) return;
    setDialing(true);
    try {
      const r = await placeCall(contact.id);
      if (r.kind === 'placed') { setDialed(true); toast('Calling your phone now. Pick up to connect.', 'success'); }
      else if (r.kind === 'not_configured') { setManualDial(true); setDialed(true); }
      else if (r.reason === 'dnc') { toast('That number is on the do-not-call list. Loading the next contact.', 'info'); await next(); }
      else { toast('Outside calling hours for this contact. Loading the next one.', 'info'); await next(); }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not place the call', 'error');
      setAutoDial(false);
    } finally {
      setDialing(false);
    }
  }, [contact, dialing, dialed, next, toast]);

  const previewLeft = secondsUntil(previewUntil, tick);
  useEffect(() => {
    if (phase === 'ready' && autoDial && !dialed && !dialing && previewLeft === 0) void dial();
  }, [phase, autoDial, dialed, dialing, previewLeft, dial]);

  const finish = useCallback(async (d: Disposition, rule?: DispositionRule) => {
    if (!contact || saving) return;
    if (rule?.needsCallback && !callbackAt) { setNeedCallback(true); return; }
    setSaving(true);
    try {
      await completeAttempt(contact.id, d, note, rule?.needsCallback ? new Date(callbackAt).toISOString() : null);
      onChanged();
      setContact(null);
      busyRef.current = false;
      await next();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the outcome', 'error');
    } finally {
      setSaving(false);
    }
  }, [contact, saving, callbackAt, note, next, onChanged, toast]);

  const skip = async () => {
    if (!contact) return;
    setAutoDial(false);
    try {
      await deferContact(contact.id, new Date(Date.now() + SKIP_DEFER_MINUTES * 60_000));
      await next();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not skip this contact', 'error');
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || phase !== 'ready' || !contact) return;
      const rule = dispositionByHotkey(e.key);
      if (rule) { e.preventDefault(); void finish(rule.key, rule); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, contact, finish]);

  if (phase === 'loading') return <SkeletonCardList count={2} />;
  if (phase === 'error') return <EmptyStateError icon={TriangleAlert} title="Could not load the next contact" description={errorText} onRetry={() => void next()} />;
  if (phase === 'wrap') {
    return (
      <div className="rounded-2xl border border-border bg-bg-secondary p-6 text-center" role="status" aria-live="polite">
        <p className="text-sm text-text-secondary">Wrap-up time. Finish your notes.</p>
        <p className="mt-2 text-4xl font-bold text-text-primary">{wrapLeft}s</p>
        <Button className="mt-4" variant="secondary" disabled>Next contact loads automatically</Button>
      </div>
    );
  }
  if (phase === 'empty' || !contact) {
    return (
      <EmptyState icon={PhoneOutgoing} title="No contacts are due right now"
        description="Everyone is either finished, waiting for a retry time, or being called by a teammate. Add more contacts or check back later."
        action={{ label: 'Check again', onClick: () => void next() }} />
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="rounded-2xl border border-border bg-bg-secondary p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Now calling</p>
            <h2 className="mt-1 text-2xl font-bold text-text-primary">{contact.name}</h2>
            <p className="text-lg text-text-secondary">{formatPhone(contact.phone_e164)}</p>
            <p className="mt-1 text-xs text-text-secondary">Attempt {contact.attempts + 1} of {campaign.max_attempts}{contact.last_disposition ? ` · last: ${DISPOSITION_LABELS[contact.last_disposition] ?? contact.last_disposition}` : ''}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setAutoDial((v) => !v)} aria-pressed={autoDial}>
              {autoDial ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />} Auto-dial {autoDial ? 'on' : 'off'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void skip()}><SkipForward size={14} aria-hidden="true" /> Skip</Button>
          </div>
        </div>
        {contact.notes && <p className="mt-3 rounded-xl bg-bg-tertiary px-3 py-2 text-sm text-text-secondary">{contact.notes}</p>}

        <div className="mt-4">
          {!dialed ? (
            <Button size="lg" className="w-full sm:w-auto" onClick={() => void dial()} disabled={dialing}>
              {dialing ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : <PhoneCall size={18} aria-hidden="true" />}
              {autoDial && previewLeft > 0 ? `Calling in ${previewLeft}s…` : 'Call now'}
            </Button>
          ) : manualDial ? (
            <a href={telHref(contact.phone_e164)} className="focus-ring inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl border border-border px-7 text-base font-semibold text-text-primary hover:bg-bg-tertiary sm:w-auto">
              <Phone size={18} aria-hidden="true" /> Dial {formatPhone(contact.phone_e164)} on this device
            </a>
          ) : (
            <p role="status" className="text-sm font-medium text-success-500">Call placed. Pick up your phone, then choose the outcome below.</p>
          )}
        </div>
      </div>

      {campaign.script && (
        <details className="rounded-2xl border border-border bg-bg-secondary p-4" open>
          <summary className="cursor-pointer text-sm font-semibold text-text-primary">Call script</summary>
          <p className="mt-2 whitespace-pre-wrap text-sm text-text-secondary">{campaign.script}</p>
        </details>
      )}

      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <Textarea label="Call notes" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        {needCallback && (
          <div className="mt-3">
            <Input label="Call back at" type="datetime-local" value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)} min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)} />
          </div>
        )}
        <p className="mb-2 mt-4 text-sm font-semibold text-text-primary">Outcome <span className="font-normal text-text-secondary">· keys 1-9, 0</span></p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {DISPOSITIONS.map((d) => (
            <button key={d.key} type="button" disabled={saving} onClick={() => void finish(d.key, d)}
              className={`focus-ring min-h-[48px] rounded-xl border px-3 text-sm font-semibold transition-colors disabled:opacity-50 ${TONE[d.tone]}`}>
              <span className="mr-1 text-xs opacity-60">{d.hotkey}</span>{d.label}
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------- campaign page
function CampaignView({ ownerId, campaignId, canAdmin }: { ownerId: string; campaignId: string; canAdmin: boolean }) {
  const { toast } = useToast();
  const [campaign, setCampaign] = useState<DialerCampaign | null>(null);
  const [stats, setStats] = useState<DialerStats | null>(null);
  const [recent, setRecent] = useState<DialerContact[]>([]);
  const [callerIds, setCallerIds] = useState<CallerIdOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<'edit' | 'import' | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, st, r, ids] = await Promise.all([
        fetchCampaign(ownerId, campaignId), fetchStats(ownerId), fetchRecentContacts(campaignId).catch((): DialerContact[] => []), fetchCallerIds(ownerId),
      ]);
      setCampaign(c); setStats(st[campaignId] ?? null); setRecent(r); setCallerIds(ids); setFailed(false);
    } catch { setFailed(true); } finally { setLoading(false); }
  }, [ownerId, campaignId]);

  useEffect(() => { void load(); const id = window.setInterval(() => void load(), 30_000); return () => window.clearInterval(id); }, [load]);

  const changeStatus = async (s: CampaignStatus) => {
    try { await setCampaignStatus(campaignId, s); toast(`Campaign ${CAMPAIGN_STATUS_LABELS[s].toLowerCase()}`, 'success'); await load(); }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not change the status', 'error'); }
  };

  if (loading) return <div className="space-y-4"><SkeletonStatGrid count={4} /><SkeletonCardList count={2} /></div>;
  if (failed) return <EmptyStateError icon={TriangleAlert} title="Could not load this campaign" onRetry={() => { setLoading(true); void load(); }} />;
  if (!campaign) return <EmptyState icon={PhoneOutgoing} title="Campaign not found" description="It may have been deleted." />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/dashboard/power-dialer" className="focus-ring mb-1 inline-flex items-center gap-1 rounded text-sm text-text-secondary hover:text-text-primary"><ArrowLeft size={14} aria-hidden="true" /> All campaigns</Link>
          <h1 className="text-2xl font-bold text-text-primary">{campaign.name}</h1>
          <p className="text-sm text-text-secondary">{CAMPAIGN_STATUS_LABELS[campaign.status]} · {campaign.pacing_mode === 'power' ? 'Power' : 'Preview'} pacing</p>
        </div>
        {canAdmin && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setDialog('import')}><Plus size={14} aria-hidden="true" /> Add contacts</Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog('edit')}>Settings</Button>
            {nextCampaignStatuses(campaign.status).map((s) => <Button key={s} size="sm" variant="ghost" onClick={() => void changeStatus(s)}>{CAMPAIGN_STATUS_LABELS[s] === 'Active' ? 'Activate' : CAMPAIGN_STATUS_LABELS[s]}</Button>)}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Ready to call" value={String(stats?.ready_now ?? 0)} hint={`${stats?.total_contacts ?? 0} total`} />
        <StatTile label="Finished" value={`${stats ? progressPercent(stats) : 0}%`} hint={`${stats?.done ?? 0} done · ${stats?.dnc ?? 0} do-not-call`} />
        <StatTile label="Booked" value={String(stats?.booked ?? 0)} />
        <StatTile label="Positive rate" value={`${stats ? contactRate(stats) : 0}%`} hint={`${stats?.total_attempts ?? 0} attempts`} />
      </div>

      {campaign.status === 'active' ? (
        <Console campaign={campaign} onChanged={() => void load()} />
      ) : (
        <EmptyState icon={PhoneOutgoing} title={`This campaign is ${CAMPAIGN_STATUS_LABELS[campaign.status].toLowerCase()}`}
          description={campaign.status === 'draft' ? 'Add contacts, choose a caller ID in Settings, then activate it.' : 'Activate it to start calling.'} />
      )}

      {recent.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-text-primary">Recent calls</h2>
          <ul className="space-y-1.5">
            {recent.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm">
                <span className="truncate text-text-primary">{c.name}</span>
                <span className="shrink-0 text-xs text-text-secondary">{DISPOSITION_LABELS[c.last_disposition ?? ''] ?? '—'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {dialog === 'edit' && <CampaignDialog ownerId={ownerId} campaign={campaign} callerIds={callerIds} onClose={() => setDialog(null)} onSaved={(c) => { setCampaign(c); setDialog(null); toast('Settings saved', 'success'); }} />}
      {dialog === 'import' && <ImportDialog campaignId={campaignId} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- list page
function CampaignList({ ownerId, canAdmin }: { ownerId: string; canAdmin: boolean }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [campaigns, setCampaigns] = useState<DialerCampaign[]>([]);
  const [stats, setStats] = useState<Record<string, DialerStats>>({});
  const [callerIds, setCallerIds] = useState<CallerIdOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, s, ids] = await Promise.all([fetchCampaigns(ownerId), fetchStats(ownerId).catch((): Record<string, DialerStats> => ({})), fetchCallerIds(ownerId)]);
      setCampaigns(c); setStats(s); setCallerIds(ids); setFailed(false);
    } catch { setFailed(true); } finally { setLoading(false); }
  }, [ownerId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><PhoneOutgoing size={20} /></span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Power Dialer</h1>
            <p className="mt-1 text-sm text-text-secondary">Work a call list one contact at a time with automatic pacing, outcomes and retries.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => void load()} aria-label="Refresh"><RefreshCw size={16} /></Button>
          {canAdmin && <Button size="sm" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> New campaign</Button>}
        </div>
      </div>

      {loading ? <SkeletonCardList count={3} />
        : failed ? <EmptyStateError icon={TriangleAlert} title="Could not load campaigns" onRetry={() => void load()} />
        : campaigns.length === 0 ? (
          <EmptyState icon={PhoneOutgoing} title="No campaigns yet" description="Create a campaign, add a call list and start dialing."
            action={canAdmin ? { label: 'New campaign', onClick: () => setCreating(true) } : undefined} />
        ) : (
          <ul className="space-y-3">
            {campaigns.map((c) => {
              const s = stats[c.id];
              const pct = s ? progressPercent(s) : 0;
              return (
                <li key={c.id}>
                  <Link to={`/dashboard/power-dialer/${c.id}`} className="focus-ring block rounded-2xl border border-border bg-bg-secondary p-4 transition-colors hover:border-accent/40">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-text-primary">{c.name}</p>
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${c.status === 'active' ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}>{CAMPAIGN_STATUS_LABELS[c.status]}</span>
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">{s?.total_contacts ?? 0} contacts · {s?.ready_now ?? 0} ready · {s?.booked ?? 0} booked</p>
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${c.name} progress`}>
                      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

      {creating && <CampaignDialog ownerId={ownerId} campaign={null} callerIds={callerIds} onClose={() => setCreating(false)}
        onSaved={(c) => { setCreating(false); toast('Campaign created', 'success'); navigate(`/dashboard/power-dialer/${c.id}`); }} />}
    </>
  );
}

export function PowerDialerPage() {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { campaignId } = useParams<{ campaignId: string }>();
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canAdmin = isOwner || permissions.can_manage_numbers || permissions.can_view_billing;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 pb-24 sm:px-6">
        {!ownerId ? <SkeletonCardList count={2} />
          : campaignId ? <CampaignView ownerId={ownerId} campaignId={campaignId} canAdmin={canAdmin} />
          : <CampaignList ownerId={ownerId} canAdmin={canAdmin} />}
      </div>
    </DashboardLayout>
  );
}
