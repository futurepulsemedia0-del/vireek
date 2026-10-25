import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Ban, ExternalLink, Mail, Pause, Plus, Send, Trash2, Upload, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonTable } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  CAMPAIGN_STATUS, EMPTY_DRAFT, MAIL_TYPE_OPTIONS, PIECE_STATUS, SIZE_OPTIONS, customersToRecipients, dollarsToCents,
  formatCents, formatTrackingCode, parseRecipientsCsv, validateDraft,
  type Campaign, type CampaignDraft, type DirectMailSettings, type ImportResult, type Piece, type Tone,
} from '@/lib/directMail';
import {
  addRecipients, deleteCampaign, listCampaigns, listCustomersForMail, listLandingOptions, listPieces, saveCampaign,
  sendCampaign, setCampaignStatus, suppressPiece,
} from '@/lib/directMailApi';

const TONE: Record<Tone, string> = {
  ok: 'bg-success/10 text-success', warn: 'bg-warning-500/10 text-warning-500', bad: 'bg-danger/10 text-danger',
  muted: 'bg-bg-tertiary text-text-secondary', info: 'bg-accent/10 text-accent',
};
const selectCls = 'focus-ring mt-1 block w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary';
const PAGE_SIZE = 25;

type Landing = { id: string; title: string; slug: string; status: string };

const Pill = ({ tone, children }: { tone: Tone; children: React.ReactNode }) => (
  <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium ${TONE[tone]}`}>{children}</span>
);

const toDraft = (c: Campaign): CampaignDraft => ({
  name: c.name, landing_page_id: c.landing_page_id ?? '', size: c.size, mail_type: c.mail_type, headline: c.headline, offer: c.offer,
  cta: c.cta, phone: c.phone, accent_color: c.accent_color, est_unit_cost: (c.est_unit_cost_cents / 100).toString(),
  budget_cap: c.budget_cap_cents ? (c.budget_cap_cents / 100).toString() : '',
});

// ------------------------------------------------------------------ form
function CampaignForm({ initial, landings, onCancel, onSaved }: { initial: Campaign | null; landings: Landing[]; onCancel: () => void; onSaved: (c: Campaign) => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<CampaignDraft>(initial ? toDraft(initial) : EMPTY_DRAFT);
  const [errors, setErrors] = useState<ReturnType<typeof validateDraft>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof CampaignDraft>(k: K) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value as CampaignDraft[K] }));

  const submit = async () => {
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      onSaved(await saveCampaign(initial?.id ?? null, draft));
      toast('Campaign saved.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the campaign.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6" aria-label="Campaign details">
      <button type="button" onClick={onCancel} className="focus-ring mb-4 inline-flex items-center gap-1 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary"><ArrowLeft size={14} /> Back</button>
      <h2 className="text-base font-semibold text-text-primary">{initial ? 'Edit campaign' : 'New postcard campaign'}</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Input label="Campaign name" value={draft.name} onChange={set('name')} error={errors.name} maxLength={120} required />
        <label className="block text-xs font-medium text-text-secondary">Landing page (QR destination)
          <select value={draft.landing_page_id} onChange={set('landing_page_id')} className={selectCls} aria-invalid={!!errors.landing_page_id}>
            <option value="">Choose a landing page…</option>
            {landings.map((l) => <option key={l.id} value={l.id}>{l.title}{l.status !== 'published' ? ` (${l.status})` : ''}</option>)}
          </select>
          {errors.landing_page_id && <span role="alert" className="mt-1.5 block text-xs text-danger">{errors.landing_page_id}</span>}
        </label>
        <Input label="Headline" value={draft.headline} onChange={set('headline')} error={errors.headline} maxLength={80} required />
        <Input label="Offer" value={draft.offer} onChange={set('offer')} error={errors.offer} maxLength={160} required helperText="e.g. $79 tune-up this month — new customers only" />
        <Input label="Call to action (back of card)" value={draft.cta} onChange={set('cta')} error={errors.cta} maxLength={60} />
        <Input label="Phone number (optional)" value={draft.phone} onChange={set('phone')} error={errors.phone} maxLength={32} />
        <label className="block text-xs font-medium text-text-secondary">Size
          <select value={draft.size} onChange={set('size')} className={selectCls}>{SIZE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        </label>
        <label className="block text-xs font-medium text-text-secondary">Delivery class
          <select value={draft.mail_type} onChange={set('mail_type')} className={selectCls}>{MAIL_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>)}</select>
        </label>
        <Input label="Brand color" value={draft.accent_color} onChange={set('accent_color')} error={errors.accent_color} maxLength={7} />
        <Input label="Expected cost per mailer ($)" inputMode="decimal" value={draft.est_unit_cost} onChange={set('est_unit_cost')} error={errors.est_unit_cost}
          helperText="From your Lob pricing. Used for the budget guard; real prices from Lob replace it in reports." />
        <Input label="Budget cap ($, optional)" inputMode="decimal" value={draft.budget_cap} onChange={set('budget_cap')} error={errors.budget_cap}
          helperText="Sending pauses automatically before the cap would be exceeded." />
      </div>
      <div className="mt-5 flex gap-2">
        <Button size="sm" onClick={() => void submit()} disabled={busy}>{busy ? 'Saving…' : 'Save campaign'}</Button>
        <Button size="sm" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ recipients import
function ImportBox({ campaignId, ownerId, onDone }: { campaignId: string; ownerId: string; onDone: () => void }) {
  const { toast } = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const doImport = async (result: ImportResult) => {
    if (!result.recipients.length) { toast('No valid recipients to import.', 'error'); return; }
    setBusy(true);
    try {
      const s = await addRecipients(campaignId, result.recipients);
      toast(`Added ${s.inserted} recipient${s.inserted === 1 ? '' : 's'}${s.suppressed ? ` · ${s.suppressed} on the do-not-mail list skipped` : ''}${s.duplicates ? ` · ${s.duplicates} already in the campaign` : ''}.`, 'success');
      setText(''); setPreview(null);
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add recipients.', 'error');
    } finally { setBusy(false); }
  };

  const fromCustomers = async () => {
    setBusy(true);
    try {
      const parsed = customersToRecipients(await listCustomersForMail(ownerId));
      setPreview(parsed);
      if (!parsed.recipients.length) toast('No customer has an address that can be mailed yet.', 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load customers.', 'error');
    } finally { setBusy(false); }
  };

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Add recipients">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Users size={16} className="text-accent" /> Add recipients</h3>
      <p className="mt-1 text-xs text-text-secondary">Paste CSV with a header row: <code>name, address, address2, city, state, zip</code>. Duplicates and do-not-mail addresses are skipped automatically.</p>
      <Textarea label="Recipients (CSV)" value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} rows={5} className="font-mono text-xs" />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={busy || !text.trim()} onClick={() => setPreview(parseRecipientsCsv(text))}>Check list</Button>
        <input ref={fileRef} type="file" accept=".csv,.tsv,text/csv,text/plain" className="sr-only" aria-label="Upload CSV file"
          onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setText(await f.text()); setPreview(null); } e.target.value = ''; }} />
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={14} /> Upload CSV</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void fromCustomers()}>Use my customers</Button>
      </div>
      {preview && (
        <div className="mt-4 rounded-xl border border-border bg-bg-primary p-3 text-xs" role="status">
          <p className="font-medium text-text-primary">{preview.recipients.length} ready to mail · {preview.errors.length} problem{preview.errors.length === 1 ? '' : 's'} · {preview.duplicates} duplicate{preview.duplicates === 1 ? '' : 's'}</p>
          {preview.errors.length > 0 && (
            <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto text-text-secondary">
              {preview.errors.slice(0, 20).map((e) => <li key={`${e.line}-${e.raw}`}>Line {e.line}: {e.reason}</li>)}
              {preview.errors.length > 20 && <li>…and {preview.errors.length - 20} more</li>}
            </ul>
          )}
          <Button size="sm" className="mt-3" disabled={busy || !preview.recipients.length} onClick={() => void doImport(preview)}>
            {busy ? 'Adding…' : `Add ${preview.recipients.length} recipient${preview.recipients.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ detail
function CampaignDetail({ campaign, ownerId, settings, landings, onBack, onChanged, onEdit, onDeleted }: {
  campaign: Campaign; ownerId: string; settings: DirectMailSettings; landings: Landing[];
  onBack: () => void; onChanged: (c: Campaign) => void; onEdit: () => void; onDeleted: () => void;
}) {
  const { toast } = useToast();
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [rows, setRows] = useState<Piece[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'send' | 'cancel' | 'delete' | null>(null);
  const [queued, setQueued] = useState(0);
  const cancelledRef = useRef(false);

  const landing = landings.find((l) => l.id === campaign.landing_page_id);
  const locked = campaign.status !== 'draft';

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [list, q] = await Promise.all([listPieces(campaign.id, page, PAGE_SIZE, filter), listPieces(campaign.id, 0, 1, 'queued')]);
      setRows(list.rows); setTotal(list.total); setQueued(q.total); setState('ready');
    } catch { setState('error'); }
  }, [campaign.id, page, filter]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { cancelledRef.current = true; }, []);

  const estimate = useMemo(() => queued * campaign.est_unit_cost_cents, [queued, campaign.est_unit_cost_cents]);
  const overCap = campaign.budget_cap_cents !== null && estimate > campaign.budget_cap_cents;

  const blockers: string[] = [];
  if (!settings.configured) blockers.push('Connect your print provider (Setup tab).');
  if (!settings.return_address?.line1) blockers.push('Add your return address (Setup tab).');
  if (!landing) blockers.push('Pick a landing page.');
  else if (landing.status !== 'published') blockers.push('Publish the landing page — otherwise the QR code opens nothing.');
  if (campaign.status === 'draft' && queued === 0) blockers.push('Add at least one recipient.');

  const runSend = async () => {
    setSending(true); setProgress('Starting…');
    try {
      for (let i = 0; i < 400 && !cancelledRef.current; i++) {
        const res = await sendCampaign(campaign.id);
        setProgress(`${res.submitted} sent this round · ${res.remaining} remaining`);
        if (res.status !== 'sending' || res.remaining === 0) {
          if (res.status === 'paused') toast(res.reason === 'provider_auth_failed' ? 'Lob rejected the API key — sending paused.' : 'Sending paused (cap reached or paused by you).', 'error');
          else toast('All mailers were handed to the printer.', 'success');
          break;
        }
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Sending stopped. Nothing is lost — press Resume.', 'error');
    } finally {
      setSending(false); setProgress(null);
      await load();
      onChanged((await listCampaigns(ownerId)).find((c) => c.id === campaign.id) ?? campaign);
    }
  };

  const mutate = async (fn: () => Promise<Campaign | void>, ok: string) => {
    try { const r = await fn(); if (r) onChanged(r); toast(ok, 'success'); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); }
  };

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6">
        <button type="button" onClick={onBack} className="focus-ring mb-3 inline-flex items-center gap-1 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary"><ArrowLeft size={14} /> All campaigns</button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-text-primary">{campaign.name}</h2>
            <p className="mt-1 text-xs text-text-secondary">{campaign.size.replace('x', ' × ')} in · {MAIL_TYPE_OPTIONS.find((o) => o.value === campaign.mail_type)?.label} · QR → {landing ? `/lp/${landing.slug}` : 'no landing page'}</p>
          </div>
          <Pill tone={CAMPAIGN_STATUS[campaign.status].tone}>{CAMPAIGN_STATUS[campaign.status].label}</Pill>
        </div>
        {settings.api_mode === 'test' && <p className="mt-3 text-xs text-warning-500">Test mode: sending creates proofs only — nothing is printed, mailed or charged.</p>}
        {blockers.length > 0 && campaign.status !== 'completed' && campaign.status !== 'cancelled' && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-text-secondary">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {['draft', 'paused'].includes(campaign.status) && (
            <Button size="sm" disabled={sending || blockers.length > 0} onClick={() => setConfirm('send')}><Send size={14} /> {campaign.status === 'paused' ? 'Resume sending' : 'Send campaign'}</Button>
          )}
          {campaign.status === 'sending' && !sending && <Button size="sm" disabled={blockers.length > 0 && queued === 0} onClick={() => void runSend()}><Send size={14} /> Continue sending</Button>}
          {campaign.status === 'sending' && <Button size="sm" variant="secondary" onClick={() => void mutate(() => setCampaignStatus(campaign.id, 'paused'), 'Campaign paused.')}><Pause size={14} /> Pause</Button>}
          {!locked && <Button size="sm" variant="secondary" onClick={onEdit}>Edit</Button>}
          {!['completed', 'cancelled'].includes(campaign.status) && <Button size="sm" variant="secondary" onClick={() => setConfirm('cancel')}><Ban size={14} /> Cancel</Button>}
          {campaign.status !== 'completed' && <Button size="sm" variant="ghost" onClick={() => setConfirm('delete')}><Trash2 size={14} /> Delete</Button>}
        </div>
        {sending && <p role="status" className="mt-3 text-xs font-medium text-accent">Sending… {progress} — keep this tab open.</p>}
      </section>

      {!locked && <ImportBox campaignId={campaign.id} ownerId={ownerId} onDone={() => void load()} />}

      <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Mailers">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Mailers {state === 'ready' && <span className="font-normal text-text-secondary">({total.toLocaleString()})</span>}</h3>
          <select aria-label="Filter by status" value={filter ?? ''} onChange={(e) => { setPage(0); setFilter(e.target.value || null); }}
            className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary">
            <option value="">All statuses</option>
            {Object.entries(PIECE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        {state === 'loading' && <div className="mt-4"><SkeletonTable rows={5} columns={5} /></div>}
        {state === 'error' && <div className="mt-4"><EmptyStateError icon={Mail} title="Couldn't load mailers" onRetry={() => void load()} /></div>}
        {state === 'ready' && rows.length === 0 && (
          <div className="mt-4"><EmptyState icon={Mail} title={filter ? 'No mailers with this status' : 'No recipients yet'} description={filter ? undefined : 'Add recipients above. Each gets a unique QR code and offer code.'} /></div>
        )}
        {state === 'ready' && rows.length > 0 && (
          <>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="border-b border-border text-text-secondary"><tr>
                  {['Recipient', 'Code', 'Status', 'Scans', 'Cost', ''].map((h) => <th key={h} scope="col" className="px-2 py-2 font-medium">{h}</th>)}
                </tr></thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className="border-b border-border/60 last:border-0">
                      <th scope="row" className="px-2 py-2 font-medium text-text-primary">{p.recipient_name}<span className="block font-normal text-text-secondary">{p.line1}, {p.city}, {p.state} {p.zip}</span></th>
                      <td className="px-2 py-2 font-mono">{formatTrackingCode(p.tracking_code)}</td>
                      <td className="px-2 py-2"><Pill tone={PIECE_STATUS[p.status].tone}>{PIECE_STATUS[p.status].label}</Pill>{p.last_error && <span className="mt-1 block text-danger">{p.last_error}</span>}</td>
                      <td className="px-2 py-2">{p.scan_count}</td>
                      <td className="px-2 py-2">{formatCents(p.cost_cents)}{p.cost_estimated ? '*' : ''}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap">
                        {p.provider_url && <a href={p.provider_url} target="_blank" rel="noopener noreferrer" className="focus-ring mr-2 inline-flex items-center gap-1 rounded text-accent" aria-label={`Open proof for ${p.recipient_name}`}><ExternalLink size={12} /> Proof</a>}
                        {p.status === 'queued' && <button type="button" className="focus-ring rounded text-text-secondary hover:text-danger" onClick={() => void mutate(async () => { await suppressPiece(p.id); }, 'Address added to the do-not-mail list.')}>Do not mail</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-text-secondary">
              <span>Page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <Button size="sm" variant="secondary" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          </>
        )}
      </section>

      <ConfirmDialog open={confirm === 'send'} title={`Mail ${queued.toLocaleString()} postcard${queued === 1 ? '' : 's'}?`} confirmLabel="Yes, send"
        description={`${settings.api_mode === 'live' ? 'This prints and mails real postcards and charges your Lob account.' : 'Test mode: proofs only, no charge.'} Estimated cost ${formatCents(estimate)}${overCap ? ` — above your ${formatCents(campaign.budget_cap_cents)} cap, so sending will pause when the cap is reached` : ''}. Mailed pieces cannot be recalled from here.`}
        onCancel={() => setConfirm(null)} onConfirm={async () => { setConfirm(null); await runSend(); }} />
      <ConfirmDialog open={confirm === 'cancel'} title="Cancel this campaign?" confirmLabel="Yes, cancel campaign"
        description="Mailers not yet handed to the printer are cancelled. Mailers already sent to the printer continue and stay in your reports."
        onCancel={() => setConfirm(null)} onConfirm={async () => { setConfirm(null); await mutate(() => setCampaignStatus(campaign.id, 'cancelled'), 'Campaign cancelled.'); }} />
      <ConfirmDialog open={confirm === 'delete'} title="Delete this campaign?" confirmLabel="Yes, delete"
        description="The campaign and its recipients are removed permanently. Campaigns that already mailed pieces cannot be deleted."
        onCancel={() => setConfirm(null)} onConfirm={async () => { setConfirm(null); try { await deleteCampaign(campaign.id); toast('Campaign deleted.', 'success'); onDeleted(); } catch (e) { toast(e instanceof Error ? e.message : 'Could not delete.', 'error'); } }} />
    </div>
  );
}

// ------------------------------------------------------------------ list (entry)
export function CampaignsPanel({ ownerId, settings }: { ownerId: string; settings: DirectMailSettings }) {
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [landings, setLandings] = useState<Landing[]>([]);
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'form'; campaign: Campaign | null } | { kind: 'detail'; id: string }>({ kind: 'list' });

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [c, l] = await Promise.all([listCampaigns(ownerId), listLandingOptions(ownerId)]);
      setCampaigns(c); setLandings(l); setState('ready');
    } catch { setState('error'); }
  }, [ownerId]);

  useEffect(() => { void load(); }, [load]);

  const replace = (next: Campaign) => setCampaigns((prev) => (prev.some((c) => c.id === next.id) ? prev.map((c) => (c.id === next.id ? next : c)) : [next, ...prev]));

  if (state === 'loading') return <SkeletonCardList count={3} rows={2} />;
  if (state === 'error') return <EmptyStateError icon={Mail} title="Couldn't load campaigns" onRetry={() => void load()} />;

  if (view.kind === 'form') {
    return <CampaignForm initial={view.campaign} landings={landings} onCancel={() => setView(view.campaign ? { kind: 'detail', id: view.campaign.id } : { kind: 'list' })}
      onSaved={(c) => { replace(c); setView({ kind: 'detail', id: c.id }); }} />;
  }

  if (view.kind === 'detail') {
    const campaign = campaigns.find((c) => c.id === view.id);
    if (!campaign) return <EmptyStateError icon={Mail} title="Campaign not found" onRetry={() => { setView({ kind: 'list' }); void load(); }} />;
    return <CampaignDetail campaign={campaign} ownerId={ownerId} settings={settings} landings={landings} onBack={() => setView({ kind: 'list' })}
      onChanged={replace} onEdit={() => setView({ kind: 'form', campaign })} onDeleted={() => { setCampaigns((p) => p.filter((c) => c.id !== campaign.id)); setView({ kind: 'list' }); }} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-text-secondary">Each mailer gets a unique QR code and offer code so every lead and job is traced back to the exact postcard.</p>
        <Button size="sm" onClick={() => setView({ kind: 'form', campaign: null })}><Plus size={14} /> New campaign</Button>
      </div>
      {campaigns.length === 0 ? (
        <EmptyState icon={Mail} title="No postcard campaigns yet" description="Create a campaign, add recipients, and send. You'll see responses and cost per booked job in Results."
          action={{ label: 'Create your first campaign', onClick: () => setView({ kind: 'form', campaign: null }) }} />
      ) : (
        <ul className="space-y-3">
          {campaigns.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setView({ kind: 'detail', id: c.id })}
                className="focus-ring flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4 text-left transition-colors hover:border-accent/40">
                <span className="min-w-0"><span className="block truncate text-sm font-semibold text-text-primary">{c.name}</span>
                  <span className="block truncate text-xs text-text-secondary">{c.headline || 'No headline yet'} · {new Date(c.created_at).toLocaleDateString()}</span></span>
                <Pill tone={CAMPAIGN_STATUS[c.status].tone}>{CAMPAIGN_STATUS[c.status].label}</Pill>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
