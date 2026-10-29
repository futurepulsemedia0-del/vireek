import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, FileQuestion, Paperclip, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState, EmptyStateInline } from '@/components/EmptyState';
import { formatMoney } from '@/lib/installProjects';
import {
  CHANGE_ORDER_STATUS_LABEL,
  CHANGE_ORDER_TONE,
  CHANGE_ORDER_TRANSITIONS,
  RFI_DIRECTION_LABEL,
  RFI_FILTERS,
  RFI_PRIORITY_LABEL,
  RFI_PRIORITY_TONE,
  RFI_STATUS_TONE,
  canDeleteChangeOrder,
  changeOrderSummary,
  emptyRfiForm,
  filterRfis,
  formatSignedMoney,
  rfiDaysOverdue,
  rfiDueText,
  rfiStatusLabel,
  rfiSummary,
  sortRfis,
  type ChangeOrderStatus,
  type RfiAttachment,
  type RfiFilter,
} from '@/lib/projectRfis';
import { createRfi, deleteChangeOrder, refreshOverdueRfis, setChangeOrderStatus } from '@/lib/projectRfisApi';
import { RfiDetail } from './RfiDetail';
import { RfiForm } from './RfiForm';
import { Pill, SectionHeader, Stat, panelClass, selectClass, useAction, useConfirm, type TabProps } from './projectUi';

export function RfisTab({ ownerId, bundle, today, onChanged }: TabProps) {
  const { project, phases, rfis, rfiAttachments, changeOrders } = bundle;
  const { busyKey, run } = useAction(onChanged);
  const { ask, dialog } = useConfirm();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<RfiFilter>('all');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const deepLinked = useRef(params.get('rfi'));
  const openId = params.get('rfi');

  const summary = useMemo(() => rfiSummary(rfis, today), [rfis, today]);
  const cos = useMemo(() => changeOrderSummary(changeOrders), [changeOrders]);
  const visible = useMemo(() => sortRfis(filterRfis(rfis, filter, query, today), today), [rfis, filter, query, today]);
  const filesByRfi = useMemo(() => {
    const m = new Map<string, RfiAttachment[]>();
    for (const a of rfiAttachments) (m.get(a.rfi_id) ?? m.set(a.rfi_id, []).get(a.rfi_id)!).push(a);
    return m;
  }, [rfiAttachments]);
  const counts = useMemo(() => Object.fromEntries(RFI_FILTERS.map((f) => [f.key, filterRfis(rfis, f.key, '', today).length])) as Record<RfiFilter, number>, [rfis, today]);
  const rfiNumbersByCo = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of rfis) if (r.change_order_id) (m.get(r.change_order_id) ?? m.set(r.change_order_id, []).get(r.change_order_id)!).push(r.rfi_number);
    return m;
  }, [rfis]);

  useEffect(() => { void refreshOverdueRfis(); }, []);
  useEffect(() => {
    const id = deepLinked.current;
    if (id) document.getElementById(`rfi-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);

  const toggle = (id: string) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (next.get('rfi') === id) next.delete('rfi'); else next.set('rfi', id);
      return next;
    }, { replace: true });

  const cancelled = project.status === 'cancelled';

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open" value={summary.open} hint={`${summary.awaitingUs} need our response · ${summary.awaitingThem} awaiting others`} />
        <Stat label="Overdue" value={summary.overdue} tone={summary.overdue > 0 ? 'danger' : undefined} hint={summary.overdue > 0 ? `Oldest is ${summary.oldestOverdueDays}d late` : summary.dueSoon > 0 ? `${summary.dueSoon} due within 2 days` : 'Nothing late'} />
        <Stat label="Avg. response" value={summary.avgResponseDays === null ? '—' : `${summary.avgResponseDays}d`} hint="From sent to answered" />
        <Stat label="Approved changes" value={formatSignedMoney(cos.approvedCents)} hint={`${cos.approvedDays >= 0 ? '+' : ''}${cos.approvedDays}d · ${cos.pendingCount} pending`} />
      </div>

      <section>
        <SectionHeader
          title="Requests for information"
          description="Track questions to and from the customer, GC, engineers and inspectors until each one is answered and closed."
          action={!creating && <Button size="sm" disabled={cancelled} onClick={() => setCreating(true)}><Plus size={14} aria-hidden="true" /> New RFI</Button>}
        />
        {cancelled && <p className="mb-3 text-sm text-text-secondary">This project is cancelled, so new RFIs and change orders are disabled.</p>}
        {creating && (
          <div className="mb-4">
            <RfiForm
              mode="create"
              initial={emptyRfiForm(today)}
              phases={phases}
              submitting={busyKey === 'create'}
              onCancel={() => setCreating(false)}
              onSubmit={async (v, intent) => { if (await run('create', () => createRfi(ownerId, project.id, v, intent), intent === 'open' ? 'RFI created.' : 'Draft saved.')) setCreating(false); }}
            />
          </div>
        )}

        {rfis.length === 0 ? (
          !creating && <EmptyState icon={FileQuestion} title="No RFIs yet" description="Log a question for the customer, GC or engineer, or an RFI someone sent you. Overdue ones surface on the project overview." action={cancelled ? undefined : { label: 'New RFI', onClick: () => setCreating(true) }} />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div role="group" aria-label="Filter RFIs" className="flex flex-wrap gap-1.5">
                {RFI_FILTERS.map((f) => (
                  <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} className={`focus-ring rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${filter === f.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>
                    {f.label} <span className="tabular-nums opacity-70">{counts[f.key]}</span>
                  </button>
                ))}
              </div>
              <div className="ml-auto w-full sm:w-64">
                <Input aria-label="Search RFIs" icon={Search} placeholder="Search number, subject, person…" value={query} onChange={(e) => setQuery(e.target.value)} className="py-2 text-sm" />
              </div>
            </div>

            {visible.length === 0 ? (
              <EmptyStateInline text="No RFIs match this filter." />
            ) : (
              <ul className="space-y-2">
                {visible.map((r) => {
                  const open = openId === r.id;
                  const late = rfiDaysOverdue(r, today);
                  const due = rfiDueText(r, today);
                  const fileCount = filesByRfi.get(r.id)?.length ?? 0;
                  const phaseName = phases.find((p) => p.id === r.phase_id)?.name;
                  return (
                    <li key={r.id} id={`rfi-${r.id}`} className={`${panelClass} !p-0 ${late > 0 ? 'border-danger-500/40' : ''}`}>
                      <button type="button" aria-expanded={open} aria-controls={`rfi-panel-${r.id}`} onClick={() => toggle(r.id)} className="focus-ring flex w-full items-start gap-3 rounded-2xl p-4 text-left">
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-baseline gap-x-2 text-sm"><span className="font-semibold text-text-primary">{r.rfi_number}</span><span className="min-w-0 truncate text-text-primary">{r.subject}</span></p>
                          <p className="mt-0.5 truncate text-xs text-text-secondary">
                            {RFI_DIRECTION_LABEL[r.direction]} {r.party_name}
                            {phaseName ? ` · ${phaseName}` : ''}
                            {due ? ` · ${due}` : ''}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                          {late > 0 && <Pill tone="danger">{late}d overdue</Pill>}
                          <Pill tone={RFI_STATUS_TONE[r.status]}>{rfiStatusLabel(r.status, r.direction)}</Pill>
                          {(r.priority === 'high' || r.priority === 'urgent') && <Pill tone={RFI_PRIORITY_TONE[r.priority]}>{RFI_PRIORITY_LABEL[r.priority]}</Pill>}
                          {fileCount > 0 && <span className="flex items-center gap-1 text-xs text-text-secondary"><Paperclip size={13} aria-hidden="true" /><span className="sr-only">Files: </span>{fileCount}</span>}
                          <ChevronDown size={16} aria-hidden="true" className={`text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
                        </div>
                      </button>
                      {open && (
                        <div id={`rfi-panel-${r.id}`} className="px-4 pb-4">
                          <RfiDetail ownerId={ownerId} rfi={r} attachments={filesByRfi.get(r.id) ?? []} allAttachments={rfiAttachments} changeOrders={changeOrders} phases={phases} onChanged={onChanged} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>

      <section>
        <SectionHeader title="Change orders" description="Created from an RFI when an answer changes price or schedule. Approving one is a record only — it does not change the contract value or billing." />
        {changeOrders.length === 0 ? (
          <EmptyStateInline text="No change orders yet. Open an RFI and choose “New change order from this RFI”." />
        ) : (
          <ul className="space-y-2">
            {changeOrders.map((c) => {
              const next = CHANGE_ORDER_TRANSITIONS[c.status];
              const linkedTo = rfiNumbersByCo.get(c.id);
              return (
                <li key={c.id} className={`${panelClass} flex flex-wrap items-center gap-3`}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-text-primary">{c.co_number} · {c.title}</p>
                    <p className="truncate text-xs text-text-secondary">{linkedTo?.length ? `Linked to ${linkedTo.join(', ')}` : 'Not linked to an RFI'}{c.description ? ` · ${c.description}` : ''}</p>
                  </div>
                  <p className="text-sm font-semibold tabular-nums text-text-primary">{formatSignedMoney(c.amount_cents)}<span className="ml-2 font-normal text-text-secondary">{c.schedule_days >= 0 ? '+' : ''}{c.schedule_days}d</span></p>
                  <Pill tone={CHANGE_ORDER_TONE[c.status]}>{CHANGE_ORDER_STATUS_LABEL[c.status]}</Pill>
                  {next.length > 0 && (
                    <select aria-label={`Status for ${c.co_number}`} className={`${selectClass} !w-auto`} value={c.status} disabled={busyKey === `co-${c.id}`} onChange={(e) => run(`co-${c.id}`, () => setChangeOrderStatus(ownerId, c.id, e.target.value as ChangeOrderStatus), 'Change order updated.')}>
                      <option value={c.status}>{CHANGE_ORDER_STATUS_LABEL[c.status]}</option>
                      {next.map((s) => <option key={s} value={s}>{CHANGE_ORDER_STATUS_LABEL[s]}</option>)}
                    </select>
                  )}
                  {canDeleteChangeOrder(c.status) && (
                    <button type="button" aria-label={`Delete ${c.co_number}`} onClick={() => ask({ title: 'Delete change order?', description: `${c.co_number} “${c.title}” will be deleted. Linked RFIs are kept and unlinked.`, label: 'Delete change order', onConfirm: () => run(`del-${c.id}`, () => deleteChangeOrder(ownerId, c.id), 'Change order deleted.') })} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500"><Trash2 size={16} aria-hidden="true" /></button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {cos.pendingCount > 0 && <p className="mt-2 text-xs text-text-secondary">{formatMoney(cos.pendingCents)} across {cos.pendingCount} pending change order{cos.pendingCount === 1 ? '' : 's'} awaiting a decision.</p>}
      </section>
      {dialog}
    </div>
  );
}
