import { useMemo, useState } from 'react';
import { Loader2, Plus, Target, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { Field, Pill, ProgressBar, Stat, fieldCls, panelCls, type Tone } from '@/components/acquisitions/acquisitionUi';
import { createSynergy, deleteActual, deleteSynergy, describeAcquisitionError, saveActual, setSynergyStatus } from '@/lib/acquisitionsApi';
import {
  SYNERGY_CATEGORIES, SYNERGY_CATEGORY_LABELS, SYNERGY_KIND_LABELS, SYNERGY_STATUSES, SYNERGY_STATUS_LABELS, formatCents, monthStart, parseMoneyToCents,
  synergyRollup, validateActual, validateSynergy, type Synergy, type SynergyActual, type SynergyCategory, type SynergyDraft, type SynergyKind, type SynergyStatus,
} from '@/lib/acquisitions';

interface Props {
  ownerId: string;
  acquisitionId: string;
  currency: string;
  today: string;
  synergies: Synergy[];
  actuals: SynergyActual[];
  canManage: boolean;
  onSynergies: (list: Synergy[]) => void;
  onActuals: (list: SynergyActual[]) => void;
}

const STATUS_TONE: Record<SynergyStatus, Tone> = { planned: 'neutral', in_progress: 'info', realized: 'good', at_risk: 'bad', dropped: 'neutral' };
const blank = (today: string): SynergyDraft => ({ kind: 'cost_savings', category: 'procurement', title: '', plan_annual: '', start_date: monthStart(today), status: 'planned', notes: '' });

export function SynergyPanel(p: Props) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<SynergyDraft>(() => blank(p.today));
  const [errors, setErrors] = useState<Partial<Record<keyof SynergyDraft, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Synergy | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [entry, setEntry] = useState<{ month: string; amount: string; note: string }>({ month: p.today.slice(0, 7), amount: '', note: '' });
  const [entryErr, setEntryErr] = useState<{ month?: string; amount?: string }>({});

  const roll = useMemo(() => synergyRollup(p.synergies, p.actuals, p.today), [p.synergies, p.actuals, p.today]);
  const lineById = useMemo(() => new Map(roll.lines.map((l) => [l.synergy.id, l])), [roll.lines]);
  const money = (c: number) => formatCents(c, p.currency);

  const wrap = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast(describeAcquisitionError(e), 'error'); } finally { setBusy(null); }
  };

  const add = () => {
    const e = validateSynergy(draft);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    void wrap('new', async () => { const s = await createSynergy(p.ownerId, p.acquisitionId, draft); p.onSynergies([...p.synergies, s]); setDraft(blank(p.today)); toast('Synergy added.', 'success'); });
  };
  const addActual = (s: Synergy) => {
    const e = validateActual(entry.month, entry.amount);
    setEntryErr(e);
    if (e.month || e.amount) return;
    const cents = parseMoneyToCents(entry.amount) as number;
    void wrap(s.id, async () => {
      const saved = await saveActual(p.ownerId, s.id, entry.month, cents, entry.note);
      p.onActuals([...p.actuals.filter((a) => !(a.synergy_id === s.id && a.period_month === saved.period_month)), saved]);
      setEntry({ ...entry, amount: '', note: '' }); toast('Actual saved.', 'success');
    });
  };
  const pctTone = (pct: number | null): Tone => (pct == null ? 'neutral' : pct >= 100 ? 'good' : pct >= 80 ? 'warn' : 'bad');

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {([['Cost savings', roll.cost], ['Revenue lift', roll.revenue]] as const).map(([label, r]) => (
          <div key={label} className={panelCls}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-text-primary">{label} vs plan</p>
              <Pill tone={pctTone(r.pct)}>{r.pct == null ? 'No plan accrued' : `${r.pct}% of plan`}</Pill>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
              <div><p className="text-xs text-text-secondary">Plan to date</p><p className="font-semibold tabular-nums text-text-primary">{money(r.plan)}</p></div>
              <div><p className="text-xs text-text-secondary">Actual</p><p className="font-semibold tabular-nums text-text-primary">{money(r.actual)}</p></div>
              <div><p className="text-xs text-text-secondary">Variance</p><p className={`font-semibold tabular-nums ${r.variance < 0 ? 'text-danger' : 'text-success'}`}>{r.variance > 0 ? '+' : ''}{money(r.variance)}</p></div>
            </div>
            <div className="mt-3"><ProgressBar pct={r.pct ?? 0} label={`${label} realization`} /></div>
            <p className="mt-2 text-xs text-text-secondary">Annual run-rate planned: {money(r.annual)}</p>
          </div>
        ))}
      </div>

      {p.synergies.length === 0 ? (
        <EmptyState icon={Target} title="No synergies planned yet" description="Add the cost savings and revenue lift from the deal thesis, then log what is realized each month." />
      ) : (
        <ul className="space-y-3">
          {p.synergies.map((s) => {
            const line = lineById.get(s.id);
            const mine = p.actuals.filter((a) => a.synergy_id === s.id).sort((a, b) => b.period_month.localeCompare(a.period_month));
            return (
              <li key={s.id} className={panelCls}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-text-primary">{s.title}</p>
                    <p className="text-xs text-text-secondary">{SYNERGY_KIND_LABELS[s.kind]} · {SYNERGY_CATEGORY_LABELS[s.category]} · {money(s.plan_annual_cents)}/yr from {s.start_date.slice(0, 7)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {line && s.status !== 'dropped' && <Pill tone={pctTone(line.pct)}>{money(line.actual)} of {money(line.planToDate)}</Pill>}
                    {p.canManage ? (
                      <select aria-label={`Status of ${s.title}`} className={`${fieldCls} w-auto`} value={s.status} disabled={busy === s.id}
                        onChange={(e) => void wrap(s.id, async () => { const u = await setSynergyStatus(s.id, p.ownerId, e.target.value as SynergyStatus); p.onSynergies(p.synergies.map((x) => (x.id === u.id ? u : x))); })}>
                        {SYNERGY_STATUSES.map((st) => <option key={st} value={st}>{SYNERGY_STATUS_LABELS[st]}</option>)}
                      </select>
                    ) : <Pill tone={STATUS_TONE[s.status]}>{SYNERGY_STATUS_LABELS[s.status]}</Pill>}
                  </div>
                </div>
                <button type="button" className="focus-ring mt-2 rounded-lg text-xs font-medium text-accent hover:underline" aria-expanded={openId === s.id} onClick={() => setOpenId(openId === s.id ? null : s.id)}>
                  {openId === s.id ? 'Hide monthly actuals' : `Monthly actuals (${mine.length})`}
                </button>
                {openId === s.id && (
                  <div className="mt-3 space-y-3 border-t border-border pt-3">
                    {mine.length === 0 ? <p className="text-xs text-text-secondary">Nothing logged yet.</p> : (
                      <ul className="divide-y divide-border text-sm">
                        {mine.map((a) => (
                          <li key={a.id} className="flex items-center justify-between gap-2 py-1.5">
                            <span className="text-text-secondary">{a.period_month.slice(0, 7)}{a.note ? ` · ${a.note}` : ''}</span>
                            <span className="flex items-center gap-2 font-medium tabular-nums text-text-primary">{money(a.actual_cents)}
                              {p.canManage && <button type="button" aria-label={`Delete ${a.period_month.slice(0, 7)} actual`} className="focus-ring rounded p-1 text-text-secondary hover:text-danger" disabled={busy === a.id}
                                onClick={() => void wrap(a.id, async () => { await deleteActual(a.id, p.ownerId); p.onActuals(p.actuals.filter((x) => x.id !== a.id)); })}><Trash2 size={13} /></button>}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {p.canManage && (
                      <div className="grid gap-3 sm:grid-cols-[auto_1fr_1fr_auto] sm:items-end">
                        <Input label="Month" type="month" value={entry.month} error={entryErr.month} onChange={(e) => setEntry({ ...entry, month: e.target.value })} />
                        <Input label="Realized amount" inputMode="decimal" value={entry.amount} error={entryErr.amount} placeholder="4200" onChange={(e) => setEntry({ ...entry, amount: e.target.value })} />
                        <Input label="Note (optional)" maxLength={300} value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })} />
                        <Button size="sm" onClick={() => addActual(s)} disabled={busy === s.id}>{busy === s.id && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Save</Button>
                      </div>
                    )}
                    {p.canManage && <Button variant="ghost" size="sm" onClick={() => setRemoving(s)}><Trash2 size={14} aria-hidden="true" /> Delete synergy</Button>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {p.canManage && (
        <div className={panelCls}>
          <h3 className="mb-3 text-sm font-semibold text-text-primary">Add a synergy</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Name" value={draft.title} maxLength={120} error={errors.title} placeholder="Consolidate parts purchasing" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <Input label="Planned annual amount" inputMode="decimal" value={draft.plan_annual} error={errors.plan_annual} placeholder="120000" onChange={(e) => setDraft({ ...draft, plan_annual: e.target.value })} />
            <Field label="Type">
              <select className={fieldCls} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as SynergyKind })}>
                <option value="cost_savings">Cost savings</option><option value="revenue_lift">Revenue lift</option>
              </select>
            </Field>
            <Field label="Category">
              <select className={fieldCls} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as SynergyCategory })}>
                {SYNERGY_CATEGORIES.map((c) => <option key={c} value={c}>{SYNERGY_CATEGORY_LABELS[c]}</option>)}
              </select>
            </Field>
            <Input label="Starts" type="date" value={draft.start_date} error={errors.start_date} onChange={(e) => setDraft({ ...draft, start_date: e.target.value })} />
            <Field label="Status">
              <select className={fieldCls} value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as SynergyStatus })}>
                {SYNERGY_STATUSES.map((s) => <option key={s} value={s}>{SYNERGY_STATUS_LABELS[s]}</option>)}
              </select>
            </Field>
          </div>
          <div className="mt-4 flex justify-end">
            <Button size="sm" onClick={add} disabled={busy === 'new'}>{busy === 'new' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />} Add synergy</Button>
          </div>
        </div>
      )}
      <Stat label="Plan accrues monthly" value={`${money(roll.cost.annual + roll.revenue.annual)}/yr`} sub="Plan to date = annual ÷ 12 × months since the start month (inclusive). Dropped synergies are excluded." />

      <ConfirmDialog
        open={removing !== null}
        title="Delete this synergy?"
        description={removing ? `“${removing.title}” and all its monthly actuals will be deleted.` : ''}
        confirmLabel="Delete"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          const s = removing; setRemoving(null);
          if (!s) return;
          await wrap(s.id, async () => { await deleteSynergy(s.id, p.ownerId); p.onSynergies(p.synergies.filter((x) => x.id !== s.id)); p.onActuals(p.actuals.filter((a) => a.synergy_id !== s.id)); });
        }}
      />
    </div>
  );
}
