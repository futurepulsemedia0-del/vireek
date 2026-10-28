import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Copy, FileSignature, Mail, Plus, ScrollText, Send, ShieldAlert, Trash2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCard } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  createWaiver,
  deleteDraftWaiver,
  emailWaiver,
  fetchProjectWaivers,
  fetchTemplates,
  fetchWaiverEvents,
  resetTemplate,
  saveTemplate,
  sendWaiver,
  signWaiverStaff,
  updateWaiver,
  voidWaiver,
} from '@/lib/lienWaiversApi';
import {
  DIRECTION_LABEL,
  NOT_LEGAL_ADVICE,
  PAY_APP_LABEL,
  PAY_APP_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  US_STATES,
  WAIVER_TYPES,
  WAIVER_TYPE_HINT,
  WAIVER_TYPE_LABEL,
  displayStatus,
  formatUsd,
  guessStateCode,
  hasPlaceholder,
  isFinalDraw,
  longDate,
  needsPaymentProof,
  payAppState,
  renderLienWaiver,
  resolveTemplate,
  suggestedType,
  summarize,
  waiverLink,
  type LienWaiver,
  type LienWaiverEvent,
  type LienWaiverTemplate,
  type PayAppState,
  type WaiverDirection,
  type WaiverType,
} from '@/lib/lienWaivers';
import { dollarsToCents, drawAmounts, formatDate, friendlyError, liveInvoice, todayIso, type ProjectBilling } from '@/lib/installProjects';
import { Pill, SectionHeader, Stat, panelClass, selectClass, useAction, useConfirm, type TabProps } from './projectUi';

interface FormState {
  id: string | null;
  billingId: string | null;
  direction: WaiverDirection;
  type: WaiverType;
  state: string;
  claimant: string;
  email: string;
  phone: string;
  customer: string;
  address: string;
  pname: string;
  through: string;
  amount: string;
  exceptions: string;
}

type Panel =
  | { kind: 'form'; form: FormState }
  | { kind: 'send'; w: LienWaiver }
  | { kind: 'sign'; w: LienWaiver }
  | { kind: 'void'; w: LienWaiver }
  | null;

const centsToInput = (c: number) => (c / 100).toFixed(2);
const fieldLabel = 'mb-1.5 block text-sm font-medium text-text-primary';

export function LienWaiversTab({ ownerId, bundle, today, onChanged }: TabProps) {
  const { project, billing, invoices } = bundle;
  const { toast } = useToast();
  const { profile } = useAuth();
  const company = profile?.company_name?.trim() || '';
  const [waivers, setWaivers] = useState<LienWaiver[] | null>(null);
  const [templates, setTemplates] = useState<LienWaiverTemplate[]>([]);
  const [failed, setFailed] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, LienWaiverEvent[]>>({});

  const reload = useCallback(async () => {
    setFailed(false);
    try {
      const [w, t] = await Promise.all([fetchProjectWaivers(ownerId, project.id), fetchTemplates(ownerId)]);
      setWaivers(w);
      setTemplates(t);
    } catch (e) {
      setFailed(true);
      toast(friendlyError(e, 'Could not load lien waivers.'), 'error');
    }
  }, [ownerId, project.id, toast]);

  useEffect(() => { void reload(); }, [reload]);

  const refreshAll = useCallback(async () => { await Promise.all([reload(), onChanged()]); }, [reload, onChanged]);
  const { busyKey, run } = useAction(refreshAll);
  const { ask, dialog } = useConfirm();

  const rows = useMemo(() => [...billing].sort((a, b) => a.sort_order - b.sort_order), [billing]);
  const byBilling = useMemo(() => {
    const m: Record<string, LienWaiver[]> = {};
    for (const w of waivers ?? []) if (w.billing_id) (m[w.billing_id] ??= []).push(w);
    return m;
  }, [waivers]);
  const states = useMemo(
    () => rows.map((b) => payAppState(liveInvoice(b, invoices), byBilling[b.id] ?? [])),
    [rows, invoices, byBilling],
  );
  const summary = useMemo(() => summarize(waivers ?? [], states), [waivers, states]);

  const linkedInvoicePaid = (w: LienWaiver) => w.invoice_id !== null && invoices[w.invoice_id]?.status === 'paid';

  const openCreate = (b: ProjectBilling | null, direction: WaiverDirection = 'given') => {
    const inv = b ? liveInvoice(b, invoices) : null;
    const amount = b
      ? inv && b.invoiced_gross_cents !== null
        ? Math.max(b.invoiced_gross_cents - b.retainage_withheld_cents, 0)
        : drawAmounts(project.contract_value_cents, project.retainage_percent, b.percent_of_contract).netCents
      : 0;
    setPanel({
      kind: 'form',
      form: {
        id: null,
        billingId: b?.id ?? null,
        direction,
        type: b ? suggestedType(inv, isFinalDraw(b, billing)) : 'conditional_progress',
        state: guessStateCode(project.site_address),
        claimant: direction === 'given' ? company : '',
        email: '',
        phone: '',
        customer: direction === 'given' ? project.customer_name : company,
        address: project.site_address ?? '',
        pname: project.name,
        through: today,
        amount: centsToInput(amount),
        exceptions: '',
      },
    });
  };

  const openEdit = (w: LienWaiver) =>
    setPanel({
      kind: 'form',
      form: {
        id: w.id, billingId: w.billing_id, direction: w.direction, type: w.waiver_type, state: w.state_code,
        claimant: w.claimant_name, email: w.claimant_email ?? '', phone: w.claimant_phone ?? '', customer: w.customer_name,
        address: w.property_address ?? '', pname: w.project_name ?? '', through: w.through_date,
        amount: centsToInput(w.amount_cents), exceptions: w.exceptions ?? '',
      },
    });

  const copy = async (w: LienWaiver) => {
    try {
      await navigator.clipboard.writeText(waiverLink(w.sign_token));
      toast('Link copied.', 'success');
    } catch {
      toast('Could not copy automatically. Select the link manually.', 'error');
    }
  };

  const toggleHistory = async (w: LienWaiver) => {
    if (openHistory === w.id) { setOpenHistory(null); return; }
    setOpenHistory(w.id);
    try {
      const ev = await fetchWaiverEvents(ownerId, w.id);
      setEvents((m) => ({ ...m, [w.id]: ev }));
    } catch (e) {
      toast(friendlyError(e, 'Could not load the history.'), 'error');
    }
  };

  if (failed && !waivers) return <EmptyStateError icon={ScrollText} title="Could not load lien waivers" onRetry={() => void reload()} />;
  if (!waivers) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading lien waivers">
        <Skeleton className="h-8 w-48" />
        <SkeletonCard rows={3} />
      </div>
    );
  }

  const sorted = [...waivers].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <div className="space-y-6">
      <div role="note" className="flex items-start gap-3 rounded-2xl border border-warning-500/40 bg-warning-500/10 p-4 text-sm text-text-primary">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
        <p>{NOT_LEGAL_ADVICE}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Signed" value={summary.signed} hint={`${formatUsd(summary.signedCents)} covered`} tone={summary.signed > 0 ? 'success' : undefined} />
        <Stat label="Awaiting signature" value={summary.awaiting} hint={summary.drafts > 0 ? `${summary.drafts} draft${summary.drafts === 1 ? '' : 's'}` : 'No drafts'} />
        <Stat label="Pay apps needing action" value={summary.needsAction} hint={summary.needsAction > 0 ? 'See the pay apps below' : 'All covered'} tone={summary.needsAction > 0 ? 'warning' : 'success'} />
        <Stat label="Total waivers" value={waivers.length} hint="Including void" />
      </div>

      <section>
        <SectionHeader
          title="Pay apps"
          description="Give a conditional waiver when you bill; give the unconditional one only after the payment has cleared."
          action={<Button size="sm" variant="secondary" onClick={() => openCreate(null, 'received')}><Plus size={14} aria-hidden="true" /> Collect from sub / supplier</Button>}
        />
        {rows.length === 0 ? (
          <EmptyState icon={FileSignature} title="No pay apps yet" description="Add billing steps in the Billing tab. Each one becomes a pay app you can attach waivers to." />
        ) : (
          <ul className="space-y-2">
            {rows.map((b, i) => {
              const inv = liveInvoice(b, invoices);
              const st: PayAppState = states[i];
              const mine = (byBilling[b.id] ?? []).filter((w) => w.status !== 'void');
              return (
                <li key={b.id} className={`${panelClass} flex flex-wrap items-center justify-between gap-3`}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-text-primary">{b.label}</p>
                    <p className="text-xs text-text-secondary">
                      {inv ? `${inv.invoice_number} · ${inv.status}` : 'Not invoiced'} · Due {formatDate(b.due_date)}
                      {mine.length > 0 && ` · ${mine.map((w) => `${w.waiver_number} ${STATUS_LABEL[displayStatus(w)].toLowerCase()}`).join(', ')}`}
                    </p>
                  </div>
                  <Pill tone={PAY_APP_TONE[st]}>{PAY_APP_LABEL[st]}</Pill>
                  <Button size="sm" variant="secondary" onClick={() => openCreate(b)} disabled={st === 'not_invoiced' ? false : st === 'complete'}>
                    <Plus size={14} aria-hidden="true" /> Create waiver
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {panel?.kind === 'form' && (
        <WaiverForm
          key={panel.form.id ?? 'new'}
          initial={panel.form}
          templates={templates}
          ownerId={ownerId}
          busy={busyKey === 'save'}
          onCancel={() => setPanel(null)}
          onSubmit={async (f) => {
            const cents = dollarsToCents(f.amount);
            if (cents === null) { toast('Enter a valid payment amount.', 'error'); return; }
            const payload = {
              direction: f.direction, waiver_type: f.type, state_code: f.state, claimant_name: f.claimant,
              claimant_email: f.email, claimant_phone: f.phone, customer_name: f.customer, property_address: f.address,
              project_name: f.pname, through_date: f.through, amount_cents: cents, exceptions: f.exceptions,
            };
            const ok = await run('save', () => (f.id ? updateWaiver(f.id, payload) : createWaiver({ ...payload, project_id: project.id, billing_id: f.billingId })), f.id ? 'Waiver saved.' : 'Draft created.');
            if (ok) setPanel(null);
          }}
        />
      )}

      {panel?.kind === 'send' && (
        <SendPanel
          w={panel.w}
          paid={linkedInvoicePaid(panel.w)}
          busy={busyKey === `send-${panel.w.id}`}
          onCancel={() => setPanel(null)}
          onSend={async (days, confirmed, email) => {
            const w = panel.w;
            const ok = await run(`send-${w.id}`, async () => {
              await sendWaiver(w.id, days, confirmed);
              if (email) {
                try { await emailWaiver(w.id, 'request', email); } catch (e) { toast(e instanceof Error ? e.message : 'Email failed. Copy the link instead.', 'error'); }
              }
            }, 'Waiver sent for signature. Use “Copy link” to share it.');
            if (ok) setPanel(null);
          }}
        />
      )}

      {panel?.kind === 'sign' && (
        <SignPanel
          w={panel.w}
          paid={linkedInvoicePaid(panel.w)}
          defaultName={panel.w.direction === 'given' ? '' : panel.w.claimant_name}
          busy={busyKey === `sign-${panel.w.id}`}
          onCancel={() => setPanel(null)}
          onSign={async (name, title, method, confirmed) => {
            const w = panel.w;
            const ok = await run(`sign-${w.id}`, () => signWaiverStaff(w.id, name, title, method, confirmed), 'Signature recorded.');
            if (ok) setPanel(null);
          }}
        />
      )}

      {panel?.kind === 'void' && (
        <VoidPanel
          w={panel.w}
          busy={busyKey === `void-${panel.w.id}`}
          onCancel={() => setPanel(null)}
          onVoid={async (reason) => {
            const w = panel.w;
            const ok = await run(`void-${w.id}`, () => voidWaiver(w.id, reason), 'Waiver voided.');
            if (ok) setPanel(null);
          }}
        />
      )}

      <section>
        <SectionHeader title="All waivers" description="Every waiver on this project, with its full signature history." />
        {sorted.length === 0 ? (
          <EmptyState icon={ScrollText} title="No lien waivers yet" description="Create one from a pay app above. Unconditional waivers are blocked until the invoice is paid." />
        ) : (
          <ul className="space-y-2">
            {sorted.map((w) => {
              const st = displayStatus(w);
              const busy = busyKey?.endsWith(w.id) ?? false;
              return (
                <li key={w.id} className={panelClass}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-text-primary">
                        {w.waiver_number} · {WAIVER_TYPE_LABEL[w.waiver_type]} · {w.state_code}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {w.direction === 'given' ? 'Given by' : 'Collected from'} {w.claimant_name} · {formatUsd(w.amount_cents)} through {longDate(w.through_date)}
                        {w.signed_at && ` · signed ${formatDate(w.signed_at)} by ${w.signer_name}`}
                        {st === 'sent' && w.expires_at && ` · link valid until ${formatDate(w.expires_at)}`}
                      </p>
                      {w.requires_notary && st !== 'draft' && <p className="mt-1 text-xs text-warning-500">Needs notarization — an e-signature alone may not be enough.</p>}
                    </div>
                    <Pill tone={STATUS_TONE[st]}>{STATUS_LABEL[st]}</Pill>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {st === 'draft' && (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => openEdit(w)}>Edit</Button>
                        <Button size="sm" onClick={() => setPanel({ kind: 'send', w })}><Send size={14} aria-hidden="true" /> Request signature</Button>
                        <Button size="sm" variant="secondary" onClick={() => setPanel({ kind: 'sign', w })}><FileSignature size={14} aria-hidden="true" /> {w.direction === 'given' ? 'Sign now' : 'Record signature'}</Button>
                        <button type="button" aria-label={`Delete ${w.waiver_number}`} disabled={busy} onClick={() => ask({ title: 'Delete this draft?', description: `${w.waiver_number} will be removed. Drafts have not been sent or signed.`, label: 'Delete draft', onConfirm: () => run(`del-${w.id}`, () => deleteDraftWaiver(ownerId, w.id), 'Draft deleted.') })} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500"><Trash2 size={16} aria-hidden="true" /></button>
                      </>
                    )}
                    {(st === 'sent' || st === 'expired') && (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => void copy(w)}><Copy size={14} aria-hidden="true" /> Copy link</Button>
                        <Button size="sm" variant="secondary" onClick={() => setPanel({ kind: 'send', w })}><Send size={14} aria-hidden="true" /> {st === 'expired' ? 'Renew link' : 'Resend'}</Button>
                        <Button size="sm" variant="secondary" onClick={() => setPanel({ kind: 'sign', w })}>Record signature</Button>
                      </>
                    )}
                    {st === 'signed' && (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => void copy(w)}><Copy size={14} aria-hidden="true" /> Copy link</Button>
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => { const to = window.prompt('Email the signed copy to:', w.claimant_email ?? ''); if (to) void run(`mail-${w.id}`, () => emailWaiver(w.id, 'copy', to.trim()), 'Signed copy emailed.'); }}><Mail size={14} aria-hidden="true" /> Email copy</Button>
                      </>
                    )}
                    {(st === 'sent' || st === 'expired' || st === 'signed') && (
                      <Button size="sm" variant="ghost" onClick={() => setPanel({ kind: 'void', w })}><XCircle size={14} aria-hidden="true" /> Void</Button>
                    )}
                    <button type="button" onClick={() => void toggleHistory(w)} aria-expanded={openHistory === w.id} className="focus-ring ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-text-secondary hover:text-text-primary">
                      History {openHistory === w.id ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                    </button>
                  </div>

                  {openHistory === w.id && (
                    <ol className="mt-3 space-y-1.5 border-t border-border pt-3 text-xs text-text-secondary">
                      {(events[w.id] ?? []).length === 0 ? <li>No history yet.</li> : (events[w.id] ?? []).map((ev) => (
                        <li key={ev.id} className="flex flex-wrap gap-x-2">
                          <span className="font-medium text-text-primary">{ev.event_type}</span>
                          <span>{new Date(ev.created_at).toLocaleString()}</span>
                          {ev.actor_name && <span>· {ev.actor_name}</span>}
                          {typeof ev.detail?.method === 'string' && <span>· {ev.detail.method}</span>}
                          {typeof ev.detail?.ip === 'string' && <span>· {ev.detail.ip}</span>}
                          {typeof ev.detail?.reason === 'string' && <span>· “{ev.detail.reason}”</span>}
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <TemplatesPanel ownerId={ownerId} templates={templates} defaultState={guessStateCode(project.site_address)} onChanged={reload} />
      {dialog}
    </div>
  );
}

// ------------------------------------------------------------------

function WaiverForm({ initial, templates, ownerId, busy, onSubmit, onCancel }: {
  initial: FormState; templates: LienWaiverTemplate[]; ownerId: string; busy: boolean;
  onSubmit: (f: FormState) => void | Promise<void>; onCancel: () => void;
}) {
  const [f, setF] = useState<FormState>(initial);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const cents = dollarsToCents(f.amount);
  const tpl = resolveTemplate(templates, f.state, f.type, ownerId);
  const bad = hasPlaceholder(f.claimant) || hasPlaceholder(f.customer) || hasPlaceholder(f.address) || hasPlaceholder(f.pname) || hasPlaceholder(f.exceptions);
  const valid = f.claimant.trim() && f.customer.trim() && f.through && cents !== null && !bad;
  const preview = tpl && cents !== null
    ? renderLienWaiver(tpl.body, { claimant_name: f.claimant || '[claimant]', customer_name: f.customer || '[customer]', property_address: f.address, project_name: f.pname, through_date: f.through, amount_cents: cents, exceptions: f.exceptions, state_code: f.state, statute_ref: tpl.statute_ref, waiver_number: 'LW-XXXX' })
    : '';

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (valid && !busy) void onSubmit(f); }} className={`${panelClass} space-y-4`} aria-label="Lien waiver form">
      <h3 className="text-sm font-semibold text-text-primary">{f.id ? 'Edit draft' : f.direction === 'given' ? 'New waiver we give' : 'New waiver we collect'}</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={fieldLabel} htmlFor="lw-dir">Direction</label>
          <select id="lw-dir" className={selectClass} value={f.direction} disabled={!!f.id} onChange={(e) => set('direction', e.target.value as WaiverDirection)}>
            {(Object.keys(DIRECTION_LABEL) as WaiverDirection[]).map((d) => <option key={d} value={d}>{DIRECTION_LABEL[d]}</option>)}
          </select>
        </div>
        <div>
          <label className={fieldLabel} htmlFor="lw-type">Waiver type</label>
          <select id="lw-type" className={selectClass} value={f.type} onChange={(e) => set('type', e.target.value as WaiverType)}>
            {WAIVER_TYPES.map((t) => <option key={t} value={t}>{WAIVER_TYPE_LABEL[t]}</option>)}
          </select>
        </div>
        <div>
          <label className={fieldLabel} htmlFor="lw-state">State form</label>
          <select id="lw-state" className={selectClass} value={f.state} onChange={(e) => set('state', e.target.value)}>
            {US_STATES.map((s) => <option key={s.code} value={s.code}>{s.code === 'US' ? s.name : `${s.name} (${s.code})`}</option>)}
          </select>
        </div>
      </div>
      <p className="text-xs text-text-secondary">{WAIVER_TYPE_HINT[f.type]}</p>
      {tpl?.is_statutory_form && tpl.user_id === null && (
        <p role="note" className="rounded-xl bg-warning-500/10 p-3 text-xs text-text-primary">
          {f.state} has a statutory form ({tpl.statute_ref}). The built-in wording is a standard starting point — confirm the exact required wording and notary rules with your attorney, then save your own copy under “Waiver forms”.
        </p>
      )}
      {!tpl && <p role="alert" className="text-xs text-danger-500">No wording exists for this state and type. Save your own under “Waiver forms” first.</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Input label={f.direction === 'given' ? 'Claimant (your company)' : 'Claimant (sub / supplier)'} required value={f.claimant} maxLength={200} onChange={(e) => set('claimant', e.target.value)} />
        <Input label="Owner / customer" required value={f.customer} maxLength={200} onChange={(e) => set('customer', e.target.value)} />
        <Input label="Claimant email (optional)" type="email" value={f.email} maxLength={254} onChange={(e) => set('email', e.target.value)} />
        <Input label="Claimant phone (optional)" type="tel" value={f.phone} maxLength={40} onChange={(e) => set('phone', e.target.value)} />
        <Input label="Property address" value={f.address} maxLength={300} onChange={(e) => set('address', e.target.value)} />
        <Input label="Project name" value={f.pname} maxLength={200} onChange={(e) => set('pname', e.target.value)} />
        <Input label="Through date" type="date" required value={f.through} onChange={(e) => set('through', e.target.value)} />
        <Input label="Payment amount ($)" inputMode="decimal" required value={f.amount} onChange={(e) => set('amount', e.target.value)} error={cents === null ? 'Enter a valid amount' : undefined} />
      </div>
      <Textarea label="Exceptions (disputed claims, items not covered)" rows={2} value={f.exceptions} maxLength={2000} onChange={(e) => set('exceptions', e.target.value)} helperText="Leave empty for “None”." />
      {bad && <p role="alert" className="text-xs text-danger-500">Curly braces ({'{{ }}'}) are not allowed in these fields.</p>}

      {preview && (
        <details className="rounded-xl border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium text-text-primary">Preview the wording</summary>
          <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-text-secondary">{preview}</pre>
        </details>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!valid || !tpl || busy}>{busy ? 'Saving…' : f.id ? 'Save changes' : 'Create draft'}</Button>
      </div>
    </form>
  );
}

function PaymentProof({ w, paid, confirmed, onChange }: { w: LienWaiver; paid: boolean; confirmed: boolean; onChange: (v: boolean) => void }) {
  if (!needsPaymentProof(w)) return null;
  if (paid) return <p className="flex items-center gap-2 text-sm text-success-500"><CheckCircle2 size={16} aria-hidden="true" /> The linked invoice is paid, so this unconditional waiver can be released.</p>;
  return (
    <label className="flex items-start gap-3 rounded-xl bg-warning-500/10 p-3 text-sm text-text-primary">
      <input type="checkbox" checked={confirmed} onChange={(e) => onChange(e.target.checked)} className="focus-ring mt-0.5 h-5 w-5 shrink-0 rounded border-border" />
      <span><strong>Unconditional waivers release your lien rights.</strong> The linked invoice is not marked paid. I confirm the payment of {formatUsd(w.amount_cents)} has been received and cleared.</span>
    </label>
  );
}

function SendPanel({ w, paid, busy, onSend, onCancel }: { w: LienWaiver; paid: boolean; busy: boolean; onSend: (days: number, confirmed: boolean, email: string) => void | Promise<void>; onCancel: () => void }) {
  const [days, setDays] = useState('14');
  const [confirmed, setConfirmed] = useState(false);
  const [email, setEmail] = useState(w.claimant_email ?? '');
  const d = Number(days);
  const needsProof = needsPaymentProof(w) && w.status === 'draft' && !paid && !confirmed;
  const valid = Number.isInteger(d) && d >= 1 && d <= 90 && !needsProof;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (valid && !busy) void onSend(d, confirmed, email.trim()); }} className={`${panelClass} space-y-3`} aria-label="Request signature">
      <h3 className="text-sm font-semibold text-text-primary">{w.status === 'draft' ? 'Request signature' : 'Refresh the signing link'} · {w.waiver_number}</h3>
      {w.status === 'draft' && <p className="text-xs text-text-secondary">The wording is locked as soon as you send it. Editing afterwards means voiding and creating a new waiver.</p>}
      {w.status === 'draft' && <PaymentProof w={w} paid={paid} confirmed={confirmed} onChange={setConfirmed} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Link valid for (days, 1–90)" type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} />
        <Input label="Email the link to (optional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} helperText="Or use “Copy link” afterwards." />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!valid || busy}>{busy ? 'Sending…' : 'Send'}</Button>
      </div>
    </form>
  );
}

function SignPanel({ w, paid, defaultName, busy, onSign, onCancel }: {
  w: LienWaiver; paid: boolean; defaultName: string; busy: boolean;
  onSign: (name: string, title: string, method: 'in_app' | 'paper' | 'email' | 'other', confirmed: boolean) => void | Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [title, setTitle] = useState('');
  const [method, setMethod] = useState<'in_app' | 'paper' | 'email' | 'other'>(w.direction === 'given' ? 'in_app' : 'paper');
  const [confirmed, setConfirmed] = useState(false);
  const proofOk = !needsPaymentProof(w) || paid || w.payment_confirmed_by !== null || confirmed;
  const valid = name.trim().length >= 2 && proofOk;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (valid && !busy) void onSign(name.trim(), title.trim(), method, confirmed); }} className={`${panelClass} space-y-3`} aria-label="Record signature">
      <h3 className="text-sm font-semibold text-text-primary">{w.direction === 'given' ? 'Sign this waiver now' : 'Record a received signature'} · {w.waiver_number}</h3>
      <p className="text-xs text-text-secondary">{w.direction === 'given' ? 'You are signing for the claimant. Your name, title, time and account are recorded.' : 'Use this when the signed copy came back on paper or by email. For e-signature, request it by link instead.'}</p>
      <PaymentProof w={w} paid={paid || w.payment_confirmed_by !== null} confirmed={confirmed} onChange={setConfirmed} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="Signer’s full name" required value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
        <Input label="Title / role" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
        <div>
          <label className={fieldLabel} htmlFor="lw-method">How was it signed?</label>
          <select id="lw-method" className={selectClass} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="in_app">Signed in Vireek</option>
            <option value="paper">Paper / in person</option>
            <option value="email">Emailed copy</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!valid || busy}>{busy ? 'Saving…' : 'Record signature'}</Button>
      </div>
    </form>
  );
}

function VoidPanel({ w, busy, onVoid, onCancel }: { w: LienWaiver; busy: boolean; onVoid: (reason: string) => void | Promise<void>; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const valid = reason.trim().length >= 3;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (valid && !busy) void onVoid(reason.trim()); }} className={`${panelClass} space-y-3`} aria-label="Void waiver">
      <h3 className="text-sm font-semibold text-text-primary">Void {w.waiver_number}?</h3>
      <p className="text-xs text-text-secondary">A voided waiver is kept for the record but no longer counts toward pay-app coverage. {w.status === 'signed' ? 'It was already signed — tell the other party it has been replaced.' : ''}</p>
      <Textarea label="Reason" required rows={2} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Keep waiver</Button>
        <Button type="submit" size="sm" disabled={!valid || busy}>{busy ? 'Voiding…' : 'Void waiver'}</Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------

function TemplatesPanel({ ownerId, templates, defaultState, onChanged }: { ownerId: string; templates: LienWaiverTemplate[]; defaultState: string; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(defaultState);
  const [type, setType] = useState<WaiverType>('conditional_progress');
  const [busy, setBusy] = useState(false);
  const tpl = resolveTemplate(templates, state, type, ownerId);
  const own = tpl !== null && tpl.user_id === ownerId && tpl.state_code === state;
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [ref, setRef] = useState('');
  const [notary, setNotary] = useState(false);

  useEffect(() => {
    setTitle(tpl?.title ?? '');
    setBody(tpl?.body ?? '');
    setRef(tpl?.statute_ref ?? '');
    setNotary(tpl?.requires_notary ?? false);
  }, [tpl?.id, tpl?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok, 'success'); await onChanged(); } catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); } finally { setBusy(false); }
  };

  return (
    <section className={panelClass}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="focus-ring flex w-full items-center justify-between text-left">
        <span>
          <span className="block text-sm font-semibold text-text-primary">Waiver forms</span>
          <span className="block text-xs text-text-secondary">State wording is data. Review it with your attorney and save your own copy per state.</span>
        </span>
        {open ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
      </button>
      {open && (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={fieldLabel} htmlFor="tp-state">State</label>
              <select id="tp-state" className={selectClass} value={state} onChange={(e) => setState(e.target.value)}>
                {US_STATES.map((s) => <option key={s.code} value={s.code}>{s.code === 'US' ? s.name : `${s.name} (${s.code})`}</option>)}
              </select>
            </div>
            <div>
              <label className={fieldLabel} htmlFor="tp-type">Type</label>
              <select id="tp-type" className={selectClass} value={type} onChange={(e) => setType(e.target.value as WaiverType)}>
                {WAIVER_TYPES.map((t) => <option key={t} value={t}>{WAIVER_TYPE_LABEL[t]}</option>)}
              </select>
            </div>
          </div>
          {!tpl ? <p className="text-sm text-text-secondary">No wording for this combination yet. Write your own below.</p> : (
            <p className="text-xs text-text-secondary">
              {own ? `Your own copy (v${tpl.version}).` : tpl.state_code === state ? 'Vireek library wording.' : 'Generic wording (no state-specific form).'}
              {tpl.is_statutory_form && ' Statutory-form state — verify the exact wording with counsel.'}
              {tpl.notes && ` ${tpl.notes}`}
            </p>
          )}
          <Input label="Title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          <Textarea label="Wording" rows={12} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} helperText="Placeholders: {{waiver_number}} {{claimant_name}} {{customer_name}} {{property_address}} {{project_name}} {{through_date}} {{amount}} {{exceptions}} {{state}} {{statute_ref}}" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Statute / form reference" value={ref} maxLength={200} onChange={(e) => setRef(e.target.value)} />
            <label className="flex items-center gap-3 self-end pb-3 text-sm text-text-primary">
              <input type="checkbox" checked={notary} onChange={(e) => setNotary(e.target.checked)} className="focus-ring h-5 w-5 rounded border-border" /> Requires notarization
            </label>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {own && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => resetTemplate(state, type), 'Back to the library wording.')}>Reset to library</Button>}
            <Button size="sm" disabled={busy || !title.trim() || !body.trim()} onClick={() => void act(() => saveTemplate({ state, type, title, body, statuteRef: ref, requiresNotary: notary }), 'Your wording was saved. It applies to new waivers only.')}>Save as my wording</Button>
          </div>
        </div>
      )}
    </section>
  );
}
