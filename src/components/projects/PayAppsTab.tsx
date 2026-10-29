import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCard } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  addSovLine,
  createPayAppInvoice,
  deleteSovLine,
  fetchContractorName,
  fetchPayAppsData,
  savePayApp,
  seedSovFromPhases,
  transitionPayApp,
  updateSovLine,
  type PayAppsData,
} from '@/lib/payAppsApi';
import {
  PAY_APP_STATUS_LABEL,
  friendlyPayAppError,
  nextItemNo,
  type PayApp,
  type PayAppStatus,
} from '@/lib/payApps';
import type { PayAppPdfInput } from '@/lib/payAppPdf';
import { addDaysIso, centsToDollarsInput, dollarsToCents, formatDate, formatMoney, liveInvoice } from '@/lib/installProjects';
import { PayAppSheet } from './PayAppSheet';
import { Pill, SectionHeader, Stat, panelClass, useAction, useConfirm, type TabProps } from './projectUi';

type View = { kind: 'list' } | { kind: 'draft' } | { kind: 'app'; id: string };

const DEFAULT_TERMS_DAYS = 14;
const statusTone: Record<PayAppStatus, 'neutral' | 'info' | 'success' | 'danger'> = { draft: 'neutral', issued: 'info', paid: 'success', void: 'danger' };

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PayAppsTab({ ownerId, bundle, today }: TabProps) {
  const { project, phases, billing, invoices } = bundle;
  const { toast } = useToast();
  const [data, setData] = useState<PayAppsData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [view, setView] = useState<View>({ kind: 'list' });
  const { ask, dialog } = useConfirm();

  const load = useCallback(async () => {
    try {
      setData(await fetchPayAppsData(ownerId, project.id));
      setState('ready');
    } catch (e) {
      toast(friendlyPayAppError(e, 'Could not load pay applications.'), 'error');
      setState((s) => (s === 'ready' ? s : 'error'));
    }
  }, [ownerId, project.id, toast]);

  useEffect(() => {
    setState('loading');
    void load();
  }, [load]);

  const { busyKey, run } = useAction(load);

  // ---- derived ----------------------------------------------------
  const apps = useMemo(() => data?.apps ?? [], [data]);
  const sov = useMemo(() => data?.sov ?? [], [data]);
  const draft = apps.find((a) => a.status === 'draft') ?? null;
  const committed = useMemo(
    () => apps.filter((a) => a.status === 'issued' || a.status === 'paid').sort((a, b) => a.application_no - b.application_no),
    [apps],
  );
  const latest = committed[committed.length - 1] ?? null;
  const previousOf = (app: PayApp | null) => {
    const before = committed.filter((c) => !app || c.application_no < app.application_no);
    const prev = before[before.length - 1];
    return prev ? { app: prev, lines: data?.linesByApp[prev.id] ?? [] } : null;
  };
  const lockedSov = useMemo(() => {
    const s = new Set<string>();
    for (const a of committed) for (const l of data?.linesByApp[a.id] ?? []) if (l.sov_line_id) s.add(l.sov_line_id);
    return s;
  }, [committed, data]);

  const originalTotal = sov.filter((s) => !s.change_order_ref).reduce((n, s) => n + s.scheduled_value_cents, 0);
  const changeTotal = sov.filter((s) => s.change_order_ref).reduce((n, s) => n + s.scheduled_value_cents, 0);
  const contractMatches = originalTotal === project.contract_value_cents;
  const alsoUsesBillingSteps = billing.some((b) => liveInvoice(b, invoices) !== null);

  // ---- SOV form ---------------------------------------------------
  const [itemNo, setItemNo] = useState('');
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState('');
  const [coRef, setCoRef] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState('');
  const [editAmount, setEditAmount] = useState('');

  const amountCents = dollarsToCents(amount);
  const addValid = desc.trim().length > 0 && amountCents !== null && amountCents > 0;
  const suggestedNo = nextItemNo(sov);

  const addLine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addValid || amountCents === null) return;
    const ok = await run(
      'sov-add',
      () => addSovLine(ownerId, project.id, { itemNo: itemNo.trim() || suggestedNo, description: desc, scheduledCents: amountCents, changeOrderRef: coRef, sortOrder: sov.length ? Math.max(...sov.map((s) => s.sort_order)) + 1 : 0 }),
      coRef.trim() ? 'Change-order line added.' : 'Line added.',
    );
    if (ok) { setItemNo(''); setDesc(''); setAmount(''); setCoRef(''); }
  };

  // ---- PDF --------------------------------------------------------
  const downloadPdf = async (input: PayAppPdfInput) => {
    try {
      const [{ generatePayAppPdf, payAppPdfFileName }, contractorName] = await Promise.all([
        import('@/lib/payAppPdf'),
        fetchContractorName(ownerId).catch(() => null),
      ]);
      const blob = await generatePayAppPdf({ ...input, contractorName });
      downloadBlob(blob, payAppPdfFileName(project.project_number, input.app.application_no));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the PDF.', 'error');
    }
  };

  // ---- render -----------------------------------------------------
  if (state === 'loading') {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading pay applications">
        <Skeleton className="h-8 w-64" />
        <SkeletonCard rows={3} />
      </div>
    );
  }
  if (state === 'error' || !data) {
    return <EmptyStateError icon={FileSpreadsheet} title="Could not load pay applications" onRetry={() => { setState('loading'); void load(); }} />;
  }

  const closeSheet = () => setView({ kind: 'list' });

  if (view.kind === 'draft') {
    return (
      <>
        <PayAppSheet
          key={draft?.id ?? 'new'}
          mode="edit"
          project={project}
          sov={sov}
          app={draft}
          appLines={draft ? data.linesByApp[draft.id] ?? [] : null}
          previous={previousOf(draft)}
          today={today}
          busy={busyKey === 'save' || busyKey === 'issue' || busyKey === 'discard'}
          onPdf={(input) => void downloadPdf(input)}
          onClose={closeSheet}
          onSave={(v) => void run('save', () => savePayApp(v), 'Draft saved.')}
          onIssue={(v) =>
            ask({
              title: 'Issue this application?',
              description: 'The G702/G703 will be frozen. You can still void the most recent issued application later if something is wrong.',
              label: 'Issue application',
              onConfirm: async () => {
                let issuedId = '';
                const ok = await run('issue', async () => { issuedId = await savePayApp(v); await transitionPayApp(issuedId, 'issue'); }, 'Application issued.');
                if (ok && issuedId) setView({ kind: 'app', id: issuedId });
              },
            })
          }
          onDiscard={() =>
            draft &&
            ask({
              title: 'Discard this draft?',
              description: 'The amounts you entered will be deleted. Issued applications are not affected.',
              label: 'Discard draft',
              onConfirm: async () => { if (await run('discard', () => transitionPayApp(draft.id, 'discard'), 'Draft discarded.')) closeSheet(); },
            })
          }
        />
        {dialog}
      </>
    );
  }

  if (view.kind === 'app') {
    const app = apps.find((a) => a.id === view.id);
    if (!app) {
      return <EmptyState icon={FileSpreadsheet} title="Application not found" action={{ label: 'Back to applications', onClick: closeSheet }} />;
    }
    const isLatest = latest?.id === app.id;
    const invoiceOpen = app.invoice_id !== null;
    const toolbar = (
      <>
        {app.status === 'issued' && (
          <Button size="sm" variant="secondary" disabled={busyKey === 'paid'} onClick={() => void run('paid', () => transitionPayApp(app.id, 'paid'), 'Marked as paid.')}>Mark paid</Button>
        )}
        {app.status === 'paid' && (
          <Button size="sm" variant="secondary" disabled={busyKey === 'unpaid'} onClick={() => void run('unpaid', () => transitionPayApp(app.id, 'unpaid'), 'Marked as unpaid.')}>Mark unpaid</Button>
        )}
        {app.status === 'issued' && app.current_payment_due_cents > 0 && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busyKey === 'invoice'}
            onClick={() => void run('invoice', () => createPayAppInvoice(app.id, addDaysIso(today, DEFAULT_TERMS_DAYS)), 'Invoice created as a draft in Invoicing.')}
          >
            {invoiceOpen ? 'Create new invoice' : 'Create invoice'}
          </Button>
        )}
        {invoiceOpen && <Link to="/dashboard/invoices" className="text-sm text-accent underline-offset-2 hover:underline">View invoices</Link>}
        {app.status === 'issued' && isLatest && !draft && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busyKey === 'void'}
            onClick={() =>
              ask({
                title: `Void application #${app.application_no}?`,
                description: 'It stays on record as void and the next application will carry forward from the one before it. Void any linked invoice first.',
                label: 'Void application',
                onConfirm: async () => { if (await run('void', () => transitionPayApp(app.id, 'void'), 'Application voided.')) closeSheet(); },
              })
            }
          >
            Void
          </Button>
        )}
      </>
    );
    return (
      <>
        <PayAppSheet
          key={app.id}
          mode="view"
          project={project}
          sov={sov}
          app={app}
          appLines={data.linesByApp[app.id] ?? []}
          previous={previousOf(app)}
          today={today}
          busy={busyKey !== null}
          toolbar={toolbar}
          onPdf={(input) => void downloadPdf(input)}
          onClose={closeSheet}
        />
        {dialog}
      </>
    );
  }

  const canStart = sov.length > 0 && project.status !== 'cancelled';
  const fully = latest && latest.balance_to_finish_cents === 0 && latest.total_retainage_cents === 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Contract to date" value={formatMoney(originalTotal + changeTotal, true)} hint={changeTotal > 0 ? `${formatMoney(changeTotal)} in change orders` : 'No change orders'} />
        <Stat label="Completed & stored" value={formatMoney(latest?.completed_stored_cents ?? 0, true)} hint={latest ? `Application #${latest.application_no}` : 'Nothing billed yet'} />
        <Stat label="Retainage held" value={formatMoney(latest?.total_retainage_cents ?? 0, true)} hint={`${project.retainage_percent}% from project settings`} />
        <Stat label="Balance to finish" value={formatMoney(latest ? latest.balance_to_finish_cents : originalTotal + changeTotal, true)} hint={fully ? 'Fully billed and released' : 'Includes retainage'} />
      </div>

      {alsoUsesBillingSteps && (
        <div role="note" className="flex items-start gap-2 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-warning-500">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>This project already has invoices from the progress-billing schedule on the Billing tab. Pay applications do not include those amounts — use one method per project to avoid billing the same work twice.</span>
        </div>
      )}

      <section>
        <SectionHeader
          title="Pay applications"
          description="Monthly G702/G703 applications. Each one carries forward what was billed before and takes retainage from the project’s rate."
          action={
            draft ? (
              <Button size="sm" onClick={() => setView({ kind: 'draft' })}>Continue draft #{draft.application_no}</Button>
            ) : (
              <Button size="sm" disabled={!canStart} onClick={() => setView({ kind: 'draft' })} title={canStart ? undefined : 'Build the schedule of values first'}>
                <Plus size={14} aria-hidden="true" /> New application
              </Button>
            )
          }
        />
        {apps.length === 0 ? (
          <EmptyState icon={FileSpreadsheet} title="No pay applications yet" description={sov.length === 0 ? 'Start by building the schedule of values below.' : 'Create the first application to bill work completed and materials stored.'} />
        ) : (
          <ul className="space-y-2">
            {apps.map((a) => (
              <li key={a.id} className={`${panelClass} flex flex-wrap items-center justify-between gap-3`}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-text-primary">Application #{a.application_no}</p>
                  <p className="text-xs text-text-secondary">Period to {formatDate(a.period_to)}{a.status === 'draft' ? ' · not issued' : ` · issued ${formatDate(a.issued_at)}`}</p>
                </div>
                <div className="text-right text-sm tabular-nums">
                  <p className="font-semibold text-text-primary">{formatMoney(a.current_payment_due_cents)}</p>
                  <p className="text-xs text-text-secondary">due · {formatMoney(a.completed_stored_cents)} completed & stored</p>
                </div>
                <Pill tone={statusTone[a.status]}>{PAY_APP_STATUS_LABEL[a.status]}</Pill>
                <Button size="sm" variant="secondary" onClick={() => setView(a.status === 'draft' ? { kind: 'draft' } : { kind: 'app', id: a.id })}>{a.status === 'draft' ? 'Edit' : 'Open'}</Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader
          title="Schedule of values"
          description="Break the contract into line items. Each issued application is a snapshot of these lines."
          action={
            sov.length === 0 && phases.length > 0 && project.contract_value_cents > 0 ? (
              <Button size="sm" variant="secondary" disabled={busyKey === 'sov-seed'} onClick={() => void run('sov-seed', () => seedSovFromPhases(ownerId, project.id, phases, project.contract_value_cents), 'Schedule of values generated from your phases.')}>
                Generate from phases
              </Button>
            ) : undefined
          }
        />

        {sov.length > 0 && (
          <p className={`mb-3 flex items-start gap-2 text-sm ${contractMatches ? 'text-success-500' : 'text-warning-500'}`} role={contractMatches ? undefined : 'alert'}>
            {contractMatches ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />}
            {contractMatches
              ? `Original schedule of values equals the contract value (${formatMoney(project.contract_value_cents)}).`
              : `Original lines total ${formatMoney(originalTotal)} but the contract value is ${formatMoney(project.contract_value_cents)} (${formatMoney(Math.abs(originalTotal - project.contract_value_cents))} ${originalTotal > project.contract_value_cents ? 'over' : 'short'}). They must match before you can issue an application.`}
          </p>
        )}

        {sov.length === 0 ? (
          <EmptyState icon={FileSpreadsheet} title="No schedule of values yet" description={phases.length > 0 && project.contract_value_cents > 0 ? 'Generate lines from your phases (split by weight, to the exact cent) or add them one by one.' : 'Add your first line item below.'} />
        ) : (
          <ul className="space-y-2">
            {sov.map((s) => {
              const locked = lockedSov.has(s.id);
              const editing = editId === s.id;
              return (
                <li key={s.id} className={`${panelClass} flex flex-wrap items-center justify-between gap-3`}>
                  <span className="w-8 shrink-0 text-sm font-semibold text-text-secondary">{s.item_no}</span>
                  {editing ? (
                    <form
                      className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const cents = dollarsToCents(editAmount);
                        if (!editDesc.trim() || cents === null || cents <= 0) return;
                        void run(`sov-edit-${s.id}`, () => updateSovLine(ownerId, s.id, { description: editDesc, ...(locked ? {} : { scheduled_value_cents: cents }) }), 'Line updated.').then((ok) => ok && setEditId(null));
                      }}
                    >
                      <Input aria-label="Description" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} className="min-w-[160px] flex-1 py-1.5 text-sm" maxLength={200} />
                      <Input aria-label="Scheduled value" inputMode="decimal" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} disabled={locked} className="w-32 py-1.5 text-sm" />
                      <Button type="submit" size="sm" variant="secondary" disabled={busyKey === `sov-edit-${s.id}`}>Save</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setEditId(null)}>Cancel</Button>
                    </form>
                  ) : (
                    <>
                      <p className="min-w-0 flex-1 truncate text-sm text-text-primary">
                        {s.description}
                        {s.change_order_ref && <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">{s.change_order_ref}</span>}
                      </p>
                      <span className="text-sm font-semibold tabular-nums text-text-primary">{formatMoney(s.scheduled_value_cents)}</span>
                      {locked && <span title="On an issued application — the value is locked. Add a change-order line to adjust the contract."><Lock size={14} className="text-text-secondary" aria-label="Locked" /></span>}
                      <div className="flex items-center gap-1">
                        <button type="button" aria-label={`Edit item ${s.item_no}`} onClick={() => { setEditId(s.id); setEditDesc(s.description); setEditAmount(centsToDollarsInput(s.scheduled_value_cents)); }} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary">
                          <Pencil size={16} aria-hidden="true" />
                        </button>
                        {!locked && (
                          <button
                            type="button"
                            aria-label={`Delete item ${s.item_no}`}
                            onClick={() => ask({ title: 'Delete this line?', description: `“${s.description}” will be removed from the schedule of values and from any open draft.`, label: 'Delete line', onConfirm: () => run(`sov-del-${s.id}`, () => deleteSovLine(ownerId, s.id), 'Line deleted.') })}
                            className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500"
                          >
                            <Trash2 size={16} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <form onSubmit={addLine} className={`${panelClass} mt-3 space-y-3`}>
          <h3 className="text-sm font-semibold text-text-primary">Add a line <span className="font-normal text-text-secondary">· add a change-order number to adjust the contract after billing has started</span></h3>
          <div className="grid gap-2 sm:grid-cols-[80px_1fr_150px_140px_auto]">
            <Input aria-label="Item number" placeholder={suggestedNo} value={itemNo} onChange={(e) => setItemNo(e.target.value)} className="py-2 text-sm" maxLength={20} />
            <Input aria-label="Description of work" placeholder="e.g. Rough-in & ductwork" value={desc} onChange={(e) => setDesc(e.target.value)} className="py-2 text-sm" maxLength={200} />
            <Input aria-label="Scheduled value in dollars" inputMode="decimal" placeholder="Scheduled value ($)" value={amount} onChange={(e) => setAmount(e.target.value)} className="py-2 text-sm" />
            <Input aria-label="Change order number (optional)" placeholder="Change order # (optional)" value={coRef} onChange={(e) => setCoRef(e.target.value)} className="py-2 text-sm" maxLength={40} />
            <Button type="submit" size="sm" disabled={busyKey === 'sov-add' || !addValid}><Plus size={14} aria-hidden="true" /> Add</Button>
          </div>
          {amount !== '' && amountCents === null && <p role="alert" className="text-xs text-danger-500">Enter a dollar amount, e.g. 12500 or 12,500.00.</p>}
        </form>
      </section>
      {dialog}
    </div>
  );
}
