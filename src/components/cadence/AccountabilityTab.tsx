import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Network, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { FadeIn, SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { CadenceModal, ErrorBlock, cardClass, errMsg, iconBtn, labelClass, selectClass, type TabProps } from '@/components/cadence/shared';
import { METRICS, METRIC_BY_KEY, buildSeatTree, chartGaps, wouldCreateCycle, type MetricKey, type Seat, type SeatNode } from '@/lib/cadence';
import { createSeat, deleteSeat, fetchSeats, updateSeat, type SeatInput } from '@/lib/cadenceApi';

function flatten(nodes: SeatNode[]): SeatNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

export function AccountabilityTab({ canManage, assignees }: TabProps) {
  const { toast } = useToast();
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState('');
  const [seats, setSeats] = useState<Seat[]>([]);
  const [form, setForm] = useState<{ open: boolean; item: Seat | null; parentId: string }>({ open: false, item: null, parentId: '' });
  const [removing, setRemoving] = useState<Seat | null>(null);

  const load = useCallback(async (skeleton: boolean) => {
    if (skeleton) setState('loading');
    try {
      setSeats(await fetchSeats());
      setState('ready');
    } catch (e) {
      setError(errMsg(e));
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const tree = useMemo(() => flatten(buildSeatTree(seats)), [seats]);
  const gaps = useMemo(() => chartGaps(seats), [seats]);

  const remove = async () => {
    if (!removing) return;
    try {
      await deleteSeat(removing.id);
      toast('Seat deleted.', 'success');
      setRemoving(null);
      await load(false);
    } catch (e) {
      toast(errMsg(e, 'Could not delete the seat.'), 'error');
    }
  };

  if (state === 'loading') return <SkeletonCardList count={3} />;
  if (state === 'error') return <ErrorBlock message={error} onRetry={() => void load(true)} />;

  return (
    <FadeIn>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">Every seat has one person accountable, a few responsibilities, and the numbers it owns.</p>
        {canManage && (
          <Button size="sm" onClick={() => setForm({ open: true, item: null, parentId: '' })}>
            <Plus size={16} /> New seat
          </Button>
        )}
      </div>

      {seats.length > 0 && (gaps.unownedMetrics.length > 0 || gaps.vacantSeats.length > 0) && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl border border-warning-500/30 bg-warning-500/5 p-4 text-sm" role="note">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning-500" />
          <div className="space-y-1 text-text-primary">
            {gaps.vacantSeats.length > 0 && <p>No one assigned to: <span className="font-semibold">{gaps.vacantSeats.join(', ')}</span>.</p>}
            {gaps.unownedMetrics.length > 0 && (
              <p>No seat owns: <span className="font-semibold">{gaps.unownedMetrics.map((k) => METRIC_BY_KEY[k].label).join(', ')}</span>.</p>
            )}
          </div>
        </div>
      )}

      {tree.length === 0 ? (
        <EmptyState
          icon={Network}
          title="No accountability chart yet"
          description="Start with the top seat (usually the owner), then add the seats that report to it."
          action={canManage ? { label: 'Add the first seat', onClick: () => setForm({ open: true, item: null, parentId: '' }) } : undefined}
        />
      ) : (
        <ul className="space-y-3">
          {tree.map((s) => (
            <li key={s.id} style={{ marginInlineStart: `${Math.min(s.depth, 4) * 20}px` }}>
              <div className={`${cardClass} ${s.depth > 0 ? 'border-s-4 border-s-accent/40' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-semibold text-text-primary">{s.title}</h3>
                    <p className="mt-0.5 inline-flex items-center gap-1.5 text-sm text-text-secondary">
                      <UserRound size={14} />
                      {s.holder_name ?? <span className="font-medium text-warning-500">Unfilled seat</span>}
                    </p>
                    {s.responsibilities.length > 0 && (
                      <ul className="mt-2 list-disc space-y-0.5 ps-5 text-sm text-text-secondary">
                        {s.responsibilities.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    )}
                    {s.metric_keys.length > 0 && (
                      <p className="mt-2 flex flex-wrap gap-1.5">
                        {s.metric_keys.map((k) => (
                          <span key={k} className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent">
                            {METRIC_BY_KEY[k].label}
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1.5">
                      <button type="button" onClick={() => setForm({ open: true, item: null, parentId: s.id })} aria-label={`Add a seat under ${s.title}`} title="Add a seat under this one" className={iconBtn}>
                        <Plus size={15} />
                      </button>
                      <button type="button" onClick={() => setForm({ open: true, item: s, parentId: s.parent_id ?? '' })} aria-label={`Edit ${s.title}`} title="Edit" className={iconBtn}>
                        <Pencil size={15} />
                      </button>
                      <button type="button" onClick={() => setRemoving(s)} aria-label={`Delete ${s.title}`} title="Delete" className={`${iconBtn} hover:text-danger-500`}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <SeatForm
        open={form.open}
        item={form.item}
        defaultParent={form.parentId}
        seats={seats}
        assignees={assignees}
        onClose={() => setForm({ open: false, item: null, parentId: '' })}
        onSaved={() => {
          setForm({ open: false, item: null, parentId: '' });
          toast('Seat saved.', 'success');
          void load(false);
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title="Delete this seat?"
        description="Seats that report to it move up to the top level. This can’t be undone."
        confirmLabel="Delete"
        onConfirm={remove}
        onCancel={() => setRemoving(null)}
      />
    </FadeIn>
  );
}

function SeatForm({
  open,
  item,
  defaultParent,
  seats,
  assignees,
  onClose,
  onSaved,
}: {
  open: boolean;
  item: Seat | null;
  defaultParent: string;
  seats: Seat[];
  assignees: TabProps['assignees'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [parentId, setParentId] = useState('');
  const [holderId, setHolderId] = useState('');
  const [resp, setResp] = useState('');
  const [metricKeys, setMetricKeys] = useState<MetricKey[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    setTitle(item?.title ?? '');
    setParentId(item ? item.parent_id ?? '' : defaultParent);
    setHolderId(item?.holder_user_id ?? '');
    setResp(item?.responsibilities.join('\n') ?? '');
    setMetricKeys(item?.metric_keys ?? []);
  }, [open, item, defaultParent]);

  const parentOptions = seats.filter((s) => !item || (s.id !== item.id && !wouldCreateCycle(seats, item.id, s.id)));
  const toggle = (k: MetricKey) => setMetricKeys((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  const lines = resp.split('\n').map((l) => l.trim()).filter(Boolean);

  const save = async () => {
    if (busy) return;
    if (!title.trim()) return setError('Give the seat a name.');
    if (lines.length > 12) return setError('Keep it to 12 responsibilities or fewer.');
    const holder = assignees.find((a) => a.userId === holderId);
    const input: SeatInput = {
      title,
      parent_id: parentId || null,
      holder_user_id: holder?.userId ?? null,
      holder_name: holder?.name ?? null,
      responsibilities: lines.map((l) => l.slice(0, 200)),
      metric_keys: metricKeys,
      ...(item ? {} : { sort_order: seats.filter((s) => (s.parent_id ?? '') === parentId).length }),
    };
    setBusy(true);
    try {
      if (item) await updateSeat(item.id, input);
      else await createSeat(input);
      onSaved();
    } catch (e) {
      const m = errMsg(e, 'Could not save the seat.');
      toast(m.includes('seat_cycle') ? 'A seat can’t report to itself or to one of its own reports.' : m, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <CadenceModal open={open} title={item ? 'Edit seat' : 'New seat'} onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <Input label="Seat name" required maxLength={120} value={title} error={error} onChange={(e) => { setTitle(e.target.value); setError(undefined); }} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="seat-parent" className={labelClass}>Reports to</label>
            <select id="seat-parent" className={selectClass} value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">Top of the chart</option>
              {parentOptions.map((s) => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="seat-holder" className={labelClass}>Who holds it</label>
            <select id="seat-holder" className={selectClass} value={holderId} onChange={(e) => setHolderId(e.target.value)}>
              <option value="">Unfilled</option>
              {assignees.map((a) => (
                <option key={a.userId} value={a.userId}>{a.name}</option>
              ))}
            </select>
          </div>
        </div>
        <Textarea label="Responsibilities (one per line, up to 12)" rows={4} value={resp} onChange={(e) => setResp(e.target.value)} />
        <fieldset>
          <legend className={labelClass}>Numbers this seat owns</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {METRICS.map((m) => (
              <label key={m.key} className="flex min-h-[40px] cursor-pointer items-center gap-2.5 text-sm text-text-primary">
                <input type="checkbox" className="focus-ring h-5 w-5 rounded border-border accent-accent" checked={metricKeys.includes(m.key)} onChange={() => toggle(m.key)} />
                {m.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save seat'}</Button>
        </div>
      </div>
    </CadenceModal>
  );
}
