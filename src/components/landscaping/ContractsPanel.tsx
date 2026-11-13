import { useState } from 'react';
import { Pause, Play, Plus, Snowflake } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { Pill, SelectField } from '@/components/tradePacks/shared';
import { ADDON_TEMPLATES, type LandscapeAddon } from '@/lib/tradePacks/landscaping/index';
import {
  cancelPause,
  createContract,
  friendlyLandscapingError,
  generateVisits,
  listAddons,
  listContracts,
  listCrews,
  listCustomers,
  listProperties,
  pauseContract,
  resumeContract,
  saveAddon,
  setContractStatus,
  updateContract,
  useLandscapeLoader,
  type ContractInput,
  type ContractListItem,
} from '@/lib/landscapingApi';
import { ContractForm, blankContract } from './ContractForm';
import { PanelState, Section, cents, dayLabel, todayISO, dollarsToCents, centsToDollars } from './ui';

const tone = (s: string) => (s === 'active' ? 'success' : s === 'paused' ? 'warning' : 'neutral');

function AddonsEditor({ ownerId, contract }: { ownerId: string; contract: ContractListItem }) {
  const { toast } = useToast();
  const addons = useLandscapeLoader((o) => listAddons(o, contract.id), [contract.id]);
  const [tpl, setTpl] = useState(0);
  const [price, setPrice] = useState(centsToDollars(ADDON_TEMPLATES[0].defaultPriceCents));
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const t = ADDON_TEMPLATES[tpl];
    setBusy(true);
    try {
      await saveAddon(ownerId, { contract_id: contract.id, kind: t.kind, label: t.label, billing: t.billing, price_cents: dollarsToCents(price), season_from_month: t.seasonFromMonth, season_to_month: t.seasonToMonth, round_months: t.roundMonths, snow_trigger_cm: t.snowTriggerCm, active: true });
      toast('Add-on added', 'success');
      addons.reload();
      if (contract.status === 'active' || contract.status === 'paused') await generateVisits(contract.id);
    } catch (e) {
      toast(friendlyLandscapingError(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (a: LandscapeAddon) => {
    try {
      await saveAddon(ownerId, { ...a, active: !a.active });
      addons.reload();
    } catch (e) {
      toast(friendlyLandscapingError(e), 'error');
    }
  };
  return (
    <div className="mt-3 rounded-xl border border-border p-3">
      <h4 className="flex items-center gap-1 text-sm font-medium text-text-primary"><Snowflake className="h-4 w-4" aria-hidden="true" />Seasonal add-ons</h4>
      <PanelState loading={addons.loading} error={addons.error} empty={(addons.data ?? []).length === 0} emptyTitle="No add-ons" emptyDescription="Snow clearing, fertilization rounds and cleanups are billed when completed." onRetry={addons.reload}>
        <ul className="mt-2 space-y-1">
          {(addons.data ?? []).map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>{a.label} · {cents(a.price_cents)}{a.kind === 'snow' && a.snow_trigger_cm ? ` · ≥ ${a.snow_trigger_cm} cm` : ''}{a.round_months.length ? ` · months ${a.round_months.join(', ')}` : ''}</span>
              <Button size="xs" variant="ghost" onClick={() => void toggle(a)}>{a.active ? 'Turn off' : 'Turn on'}</Button>
            </li>
          ))}
        </ul>
      </PanelState>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <SelectField label="Add" value={String(tpl)} onChange={(x) => { setTpl(Number(x)); setPrice(centsToDollars(ADDON_TEMPLATES[Number(x)].defaultPriceCents)); }}>
          {ADDON_TEMPLATES.map((t, i) => <option key={t.kind} value={i}>{t.label}</option>)}
        </SelectField>
        <Input label="Price ($)" type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void add()}><Plus className="mr-1 h-4 w-4" />Add</Button>
      </div>
    </div>
  );
}

export function ContractsPanel({ ownerId, canManage }: { ownerId: string; canManage: boolean }) {
  const { toast } = useToast();
  const contracts = useLandscapeLoader((o) => listContracts(o), []);
  const customers = useLandscapeLoader((o) => listCustomers(o), []);
  const properties = useLandscapeLoader((o) => listProperties(o), []);
  const crews = useLandscapeLoader((o) => listCrews(o), []);
  const [editing, setEditing] = useState<{ id: string | null; value: ContractInput; locked: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState<ContractListItem | null>(null);
  const [pauseFor, setPauseFor] = useState<ContractListItem | null>(null);
  const [pFrom, setPFrom] = useState(todayISO());
  const [pTo, setPTo] = useState('');
  const [pReason, setPReason] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, 'success');
      contracts.reload();
    } catch (e) {
      toast(friendlyLandscapingError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = (v: ContractInput) =>
    run(async () => {
      if (editing?.id) {
        await updateContract(ownerId, editing.id, v);
        await generateVisits(editing.id); // rebuilds the future schedule after a rules change
      } else await createContract(v);
      setEditing(null);
    }, 'Contract saved');

  if (editing) {
    return (
      <Section title={editing.id ? 'Edit contract' : 'New maintenance contract'}>
        <ContractForm value={editing.value} customers={customers.data ?? []} properties={properties.data ?? []} crews={crews.data ?? []} lockedStart={editing.locked} lockedBilling={editing.locked} busy={busy} onCancel={() => setEditing(null)} onSave={(v) => void save(v)} />
      </Section>
    );
  }

  const list = contracts.data ?? [];
  return (
    <div className="space-y-4">
      <Section title="Maintenance contracts" description="Recurring visits generated from each contract's rules. Pausing stops visits and billing; resuming picks the schedule back up." actions={canManage && <Button size="sm" onClick={() => setEditing({ id: null, value: blankContract(), locked: false })}><Plus className="mr-1 h-4 w-4" />New contract</Button>}>
        <PanelState loading={contracts.loading} error={contracts.error} empty={list.length === 0} emptyTitle="No contracts yet" emptyDescription="Create a contract, activate it, and visits appear on the route board." onRetry={contracts.reload}>
          <ul className="space-y-3">
            {list.map((c) => (
              <li key={c.id} className="rounded-xl border border-border bg-bg-secondary p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-text-primary">{c.title}</p>
                    <p className="text-xs text-text-secondary">{c.customer_name} · from {dayLabel(c.start_date)}{c.end_date ? ` to ${dayLabel(c.end_date)}` : ''} · {c.billing_mode === 'monthly_flat' ? `${cents(c.monthly_fee_cents)}/month` : `${cents(c.visit_price_cents)}/visit`}</p>
                  </div>
                  <Pill tone={tone(c.status)}>{c.status}</Pill>
                </div>
                {c.pauseRows.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs text-text-secondary" aria-label="Pauses">
                    {c.pauseRows.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span>Paused {dayLabel(p.from_date)} → {p.to_date ? dayLabel(p.to_date) : 'until resumed'}{p.reason ? ` (${p.reason})` : ''}</span>
                        {canManage && p.from_date > todayISO() && <Button size="xs" variant="ghost" onClick={() => void run(() => cancelPause(p.id), 'Pause withdrawn')}>Withdraw</Button>}
                      </li>
                    ))}
                  </ul>
                )}
                {canManage && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="xs" variant="secondary" onClick={() => setEditing({ id: c.id, value: { ...c }, locked: c.status !== 'draft' })}>Edit</Button>
                    {c.status === 'draft' && <Button size="xs" loading={busy} onClick={() => void run(() => setContractStatus(ownerId, c.id, 'active'), 'Contract activated')}>Activate</Button>}
                    {(c.status === 'active' || c.status === 'paused') && <Button size="xs" variant="secondary" onClick={() => { setPauseFor(c); setPFrom(todayISO()); setPTo(''); setPReason(''); }}><Pause className="mr-1 h-3 w-3" />Pause</Button>}
                    {c.status === 'paused' && <Button size="xs" variant="secondary" loading={busy} onClick={() => void run(() => resumeContract(c.id, null), 'Contract resumed')}><Play className="mr-1 h-3 w-3" />Resume today</Button>}
                    {c.status !== 'ended' && <Button size="xs" variant="ghost" onClick={() => setEnding(c)}>End</Button>}
                    <Button size="xs" variant="ghost" aria-expanded={expanded === c.id} onClick={() => setExpanded(expanded === c.id ? null : c.id)}>Add-ons</Button>
                  </div>
                )}
                {expanded === c.id && <AddonsEditor ownerId={ownerId} contract={c} />}
              </li>
            ))}
          </ul>
        </PanelState>
      </Section>

      {pauseFor && (
        <div role="dialog" aria-modal="true" aria-label="Pause contract" onKeyDown={(e) => e.key === 'Escape' && setPauseFor(null)} className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
          <div className="w-full max-w-md space-y-3 rounded-2xl bg-bg-secondary p-4 shadow-xl">
            <h3 className="text-base font-semibold text-text-primary">Pause “{pauseFor.title}”</h3>
            <Input label="Pause from" type="date" autoFocus value={pFrom} onChange={(e) => setPFrom(e.target.value)} />
            <Input label="Until (optional)" type="date" min={pFrom} value={pTo} onChange={(e) => setPTo(e.target.value)} helperText="Leave empty to pause until you resume it." />
            <Input label="Reason (optional)" value={pReason} maxLength={500} onChange={(e) => setPReason(e.target.value)} />
            <p className="text-xs text-text-secondary">Visits in this window are cancelled and not billed. A flat monthly fee is reduced for the paused days.</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPauseFor(null)}>Cancel</Button>
              <Button size="sm" loading={busy} disabled={!pFrom || (!!pTo && pTo < pFrom)} onClick={() => { const c = pauseFor; setPauseFor(null); void run(() => pauseContract(c.id, pFrom, pTo || null, pReason.trim() || null), 'Contract paused'); }}>Pause</Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={ending !== null}
        title="End this contract?"
        description="No more visits will be generated. Completed visits can still be invoiced. This cannot be undone."
        confirmLabel="End contract"
        recoverable={false}
        onCancel={() => setEnding(null)}
        onConfirm={async () => { const c = ending; setEnding(null); if (c) await run(() => setContractStatus(ownerId, c.id, 'ended'), 'Contract ended'); }}
      />
    </div>
  );
}
