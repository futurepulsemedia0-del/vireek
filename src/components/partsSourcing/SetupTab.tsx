// Recreated: verify against original intent
import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { formatMoney } from '@/lib/partsOrdering';
import {
  addCrossRef,
  addEquipmentModel,
  deleteCrossRef,
  deleteEquipmentModel,
  deleteRule,
  getSettings,
  listAudit,
  listCrossRefs,
  listEquipmentModels,
  listRules,
  saveRule,
  saveSettings,
  searchParts,
  type AuditRow,
  type CrossRef,
  type EquipmentModelLink,
  type PartHit,
} from '@/lib/partsSourcingApi';
import { centsToDecimal, formatBps, parseMoneyToCents, parsePercentToBps, type MarginRule, type RuleScope } from '@/lib/partsSourcing';
import { Chip, EmptyState, ErrorNote, LoadingRow, card, field, label } from './shared';

/** Runs `fn` once at a time and reports failures as a toast. Returns whether it succeeded. */
function useGuarded() {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async (fn: () => Promise<void>, ok?: string): Promise<boolean> => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, 'success');
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.', 'error');
      return false;
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return { busy, run };
}

export function SetupTab() {
  return (
    <div className="space-y-4">
      <SettingsCard />
      <RulesCard />
      <PartLinksCard />
      <AuditCard />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function SettingsCard() {
  const { busy, run } = useGuarded();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [truckFirst, setTruckFirst] = useState(true);
  const [buffer, setBuffer] = useState('0');
  const [threshold, setThreshold] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const s = await getSettings();
      setTruckFirst(s.truck_first);
      setBuffer(String(s.eta_buffer_days));
      setThreshold(s.approval_threshold_cents === null ? '' : centsToDecimal(s.approval_threshold_cents));
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load settings.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const bufferNum = /^\d{1,2}$/.test(buffer.trim()) ? Number(buffer) : NaN;
  const bufferOk = Number.isInteger(bufferNum) && bufferNum >= 0 && bufferNum <= 30;
  const thresholdCents = threshold.trim() === '' ? null : parseMoneyToCents(threshold);
  const thresholdOk = threshold.trim() === '' || thresholdCents !== null;

  if (error) return <ErrorNote message={error} onRetry={() => void load()} />;
  if (!loaded) return <LoadingRow text="Loading settings…" />;

  return (
    <section className={card} aria-labelledby="ps-settings">
      <h2 id="ps-settings" className="text-base font-semibold text-text-primary">Sourcing settings</h2>
      <div className="mt-4 space-y-4">
        <label className="flex items-start gap-2 text-sm text-text-primary">
          <input type="checkbox" className="mt-1" checked={truckFirst} onChange={(e) => setTruckFirst(e.target.checked)} />
          <span>
            Truck first
            <span className="block text-xs text-text-secondary">Prefer stock already on the technician’s truck before branches and suppliers.</span>
          </span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="ps-buffer" className={label}>Delivery buffer (days, 0–30)</label>
            <input id="ps-buffer" inputMode="numeric" value={buffer} onChange={(e) => setBuffer(e.target.value)} className={field} aria-invalid={!bufferOk || undefined} />
            <p className="mt-1 text-[11px] text-text-secondary">Parts must arrive this many days before the appointment.</p>
          </div>
          <div>
            <label htmlFor="ps-threshold" className={label}>Approval threshold (leave empty for none)</label>
            <input id="ps-threshold" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} className={field} placeholder="e.g. 500.00" aria-invalid={!thresholdOk || undefined} />
            <p className="mt-1 text-[11px] text-text-secondary">Orders above this amount need a manager’s approval.</p>
          </div>
        </div>
      </div>
      <div className="mt-4">
        <Button
          size="sm"
          loading={busy}
          disabled={!bufferOk || !thresholdOk}
          onClick={() => void run(() => saveSettings({ truck_first: truckFirst, eta_buffer_days: bufferNum, approval_threshold_cents: thresholdCents }), 'Settings saved.')}
        >
          Save settings
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

const SCOPES: { value: RuleScope; label: string }[] = [
  { value: 'default', label: 'Everything (default)' },
  { value: 'category', label: 'Category' },
  { value: 'brand', label: 'Brand' },
  { value: 'part', label: 'One part' },
];

interface RuleForm {
  id?: string;
  scope: RuleScope;
  scopeValue: string;
  markup: string;
  minMargin: string;
  round: string;
  priority: string;
  active: boolean;
}

const emptyRule: RuleForm = { scope: 'default', scopeValue: '', markup: '25', minMargin: '0', round: '1', priority: '0', active: true };

function RulesCard() {
  const { busy, run } = useGuarded();
  const [rules, setRules] = useState<MarginRule[] | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<RuleForm | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setRules(await listRules());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load margin rules.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const parsed = form
    ? {
        markup: parsePercentToBps(form.markup),
        minMargin: parsePercentToBps(form.minMargin),
        round: /^\d{1,5}$/.test(form.round.trim()) ? Number(form.round) : NaN,
        priority: /^-?\d{1,4}$/.test(form.priority.trim()) ? Number(form.priority) : NaN,
        scopeValue: form.scopeValue.trim(),
      }
    : null;
  const valid =
    !!form && !!parsed && parsed.markup !== null && parsed.minMargin !== null && parsed.minMargin < 10000 && parsed.round >= 1 && parsed.round <= 10000 && Number.isInteger(parsed.priority) && (form.scope === 'default' || parsed.scopeValue.length > 0);

  const submit = async () => {
    if (!form || !parsed || !valid || parsed.markup === null || parsed.minMargin === null) return;
    const ok = await run(
      () => saveRule({ id: form.id, scope: form.scope, scope_value: form.scope === 'default' ? null : parsed.scopeValue, markup_bps: parsed.markup as number, min_margin_bps: parsed.minMargin as number, round_to_cents: parsed.round, priority: parsed.priority, active: form.active }),
      'Margin rule saved.',
    );
    if (ok) {
      setForm(null);
      await load();
    }
  };

  const remove = async (id: string) => {
    const ok = await run(() => deleteRule(id), 'Margin rule deleted.');
    if (ok) {
      setConfirmDelete(null);
      await load();
    }
  };

  return (
    <section className={card} aria-labelledby="ps-rules">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="ps-rules" className="text-base font-semibold text-text-primary">Margin rules</h2>
          <p className="mt-0.5 text-xs text-text-secondary">How the sell price is worked out from cost. The most specific active rule wins.</p>
        </div>
        {!form && <Button size="sm" variant="secondary" onClick={() => setForm({ ...emptyRule })}>Add rule</Button>}
      </div>

      {error && <div className="mt-3"><ErrorNote message={error} onRetry={() => void load()} /></div>}
      {!rules && !error && <LoadingRow />}

      {rules && rules.length === 0 && !form && <div className="mt-4"><EmptyState>No rules yet. Without a rule, parts are sold at cost.</EmptyState></div>}
      {rules && rules.length > 0 && (
        <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
              <div className="min-w-0 text-sm">
                <p className="flex flex-wrap items-center gap-2 font-medium text-text-primary">
                  {r.scope === 'default' ? 'Everything' : `${r.scope}: ${r.scope_value ?? ''}`}
                  {!r.active && <Chip>Off</Chip>}
                </p>
                <p className="text-xs text-text-secondary">
                  Markup {formatBps(r.markup_bps)} · Min margin {formatBps(r.min_margin_bps)} · Round up to {formatMoney(r.round_to_cents)} · Priority {r.priority}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => setForm({ id: r.id, scope: r.scope, scopeValue: r.scope_value ?? '', markup: String(r.markup_bps / 100), minMargin: String(r.min_margin_bps / 100), round: String(r.round_to_cents), priority: String(r.priority), active: r.active })}>
                  Edit
                </Button>
                {confirmDelete === r.id ? (
                  <>
                    <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(null)} disabled={busy}>Keep</Button>
                    <Button size="xs" variant="danger" onClick={() => void remove(r.id)} loading={busy}>Delete</Button>
                  </>
                ) : (
                  <button type="button" aria-label="Delete rule" onClick={() => setConfirmDelete(r.id)} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-danger">
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {form && (
        <div className="mt-4 space-y-3 rounded-xl border border-border bg-bg-primary p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="ps-r-scope" className={label}>Applies to</label>
              <select id="ps-r-scope" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as RuleScope })} className={field}>
                {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            {form.scope !== 'default' && (
              <div>
                <label htmlFor="ps-r-value" className={label}>{form.scope === 'part' ? 'Part ID' : form.scope === 'brand' ? 'Brand name' : 'Category name'}</label>
                <input id="ps-r-value" value={form.scopeValue} maxLength={120} onChange={(e) => setForm({ ...form, scopeValue: e.target.value })} className={field} />
              </div>
            )}
            <div>
              <label htmlFor="ps-r-markup" className={label}>Markup over cost (%)</label>
              <input id="ps-r-markup" inputMode="decimal" value={form.markup} onChange={(e) => setForm({ ...form, markup: e.target.value })} className={field} aria-invalid={parsed?.markup === null || undefined} />
            </div>
            <div>
              <label htmlFor="ps-r-min" className={label}>Minimum margin on price (%)</label>
              <input id="ps-r-min" inputMode="decimal" value={form.minMargin} onChange={(e) => setForm({ ...form, minMargin: e.target.value })} className={field} aria-invalid={parsed?.minMargin === null || undefined} />
            </div>
            <div>
              <label htmlFor="ps-r-round" className={label}>Round price up to (cents)</label>
              <input id="ps-r-round" inputMode="numeric" value={form.round} onChange={(e) => setForm({ ...form, round: e.target.value })} className={field} />
            </div>
            <div>
              <label htmlFor="ps-r-priority" className={label}>Priority (higher wins ties)</label>
              <input id="ps-r-priority" inputMode="numeric" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className={field} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            Rule is active
          </label>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setForm(null)} disabled={busy}>Cancel</Button>
            <Button size="sm" onClick={() => void submit()} loading={busy} disabled={!valid}>Save rule</Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

const RELATIONS: { value: CrossRef['relation']; label: string }[] = [
  { value: 'equivalent', label: 'Equivalent' },
  { value: 'alternate', label: 'Alternate' },
  { value: 'supersedes', label: 'Supersedes' },
  { value: 'superseded_by', label: 'Superseded by' },
];

function PartLinksCard() {
  const { busy, run } = useGuarded();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PartHit[] | null>(null);
  const [searchError, setSearchError] = useState('');
  const [part, setPart] = useState<PartHit | null>(null);
  const [refs, setRefs] = useState<CrossRef[]>([]);
  const [models, setModels] = useState<EquipmentModelLink[]>([]);
  const [linkError, setLinkError] = useState('');
  const [altMpn, setAltMpn] = useState('');
  const [relation, setRelation] = useState<CrossRef['relation']>('equivalent');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [ahri, setAhri] = useState('');
  const seq = useRef(0);

  const search = async () => {
    setSearchError('');
    try {
      setHits(await searchParts(query));
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : 'Search failed.');
    }
  };

  const loadLinks = useCallback(async (p: PartHit) => {
    const mine = ++seq.current;
    setLinkError('');
    try {
      const [r, m] = await Promise.all([listCrossRefs(p.id), listEquipmentModels(p.id)]);
      if (mine === seq.current) {
        setRefs(r);
        setModels(m);
      }
    } catch (e) {
      if (mine === seq.current) setLinkError(e instanceof Error ? e.message : 'Could not load links.');
    }
  }, []);

  const choose = (p: PartHit) => {
    setPart(p);
    setRefs([]);
    setModels([]);
    void loadLinks(p);
  };

  const hasModelInput = make.trim() !== '' || model.trim() !== '' || ahri.trim() !== '';

  return (
    <section className={card} aria-labelledby="ps-links">
      <h2 id="ps-links" className="text-base font-semibold text-text-primary">Cross references &amp; equipment fit</h2>
      <p className="mt-0.5 text-xs text-text-secondary">Link alternate part numbers and the equipment a part fits, so Compare can suggest substitutes.</p>

      <div className="mt-4 flex gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="ps-link-search" className={label}>Find a part</label>
          <input id="ps-link-search" value={query} maxLength={60} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} className={field} autoComplete="off" />
        </div>
        <div className="self-end">
          <Button size="sm" variant="secondary" onClick={() => void search()} disabled={query.trim().length < 2}>
            <Search size={14} aria-hidden="true" />
            Search
          </Button>
        </div>
      </div>
      {searchError && <div className="mt-3"><ErrorNote message={searchError} onRetry={() => void search()} /></div>}
      {hits && hits.length === 0 && <div className="mt-3"><EmptyState>No parts match.</EmptyState></div>}
      {hits && hits.length > 0 && !part && (
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" onClick={() => choose(h)} className="focus-ring flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-bg-primary">
                <span className="min-w-0 truncate text-sm text-text-primary">{h.name}</span>
                <span className="shrink-0 text-xs text-text-secondary">{h.part_number ?? 'No part number'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {part && (
        <div className="mt-4 space-y-5">
          <p className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-primary">
            <span><span className="font-semibold">{part.name}</span> <span className="text-text-secondary">{part.part_number ?? ''}</span></span>
            <button type="button" onClick={() => { setPart(null); seq.current++; }} className="focus-ring rounded px-2 py-1 text-xs font-semibold text-accent hover:underline">Choose another part</button>
          </p>
          {linkError && <ErrorNote message={linkError} onRetry={() => void loadLinks(part)} />}

          <div>
            <h3 className="text-sm font-semibold text-text-primary">Cross references</h3>
            {refs.length === 0 ? (
              <p className="mt-1 text-xs text-text-secondary">None yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
                {refs.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate text-text-primary">{r.alt_mpn ?? 'Linked part'} <Chip tone="info">{r.relation.replace('_', ' ')}</Chip></span>
                    <button type="button" aria-label={`Remove cross reference ${r.alt_mpn ?? ''}`} disabled={busy} onClick={() => void run(async () => { await deleteCrossRef(r.id); await loadLinks(part); })} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-danger disabled:opacity-50">
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="min-w-[160px] flex-1">
                <label htmlFor="ps-alt" className={label}>Alternate part number</label>
                <input id="ps-alt" value={altMpn} maxLength={80} onChange={(e) => setAltMpn(e.target.value)} className={field} />
              </div>
              <div>
                <label htmlFor="ps-rel" className={label}>Relation</label>
                <select id="ps-rel" value={relation} onChange={(e) => setRelation(e.target.value as CrossRef['relation'])} className={field}>
                  {RELATIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <Button size="sm" disabled={!altMpn.trim() || busy} onClick={() => void run(async () => { await addCrossRef({ partId: part.id, altMpn, relation }); setAltMpn(''); await loadLinks(part); }, 'Cross reference added.')}>Add</Button>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-text-primary">Fits equipment</h3>
            {models.length === 0 ? (
              <p className="mt-1 text-xs text-text-secondary">None yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
                {models.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate text-text-primary">
                      {[m.make, m.model].filter(Boolean).join(' ') || 'Unnamed model'}
                      {m.ahri_ref_number && <span className="text-xs text-text-secondary"> · AHRI {m.ahri_ref_number}</span>}
                    </span>
                    <button type="button" aria-label="Remove equipment link" disabled={busy} onClick={() => void run(async () => { await deleteEquipmentModel(m.id); await loadLinks(part); })} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-danger disabled:opacity-50">
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 grid gap-2 sm:grid-cols-4">
              <div>
                <label htmlFor="ps-make" className={label}>Make</label>
                <input id="ps-make" value={make} maxLength={80} onChange={(e) => setMake(e.target.value)} className={field} />
              </div>
              <div>
                <label htmlFor="ps-model" className={label}>Model</label>
                <input id="ps-model" value={model} maxLength={80} onChange={(e) => setModel(e.target.value)} className={field} />
              </div>
              <div>
                <label htmlFor="ps-ahri" className={label}>AHRI ref</label>
                <input id="ps-ahri" value={ahri} maxLength={40} onChange={(e) => setAhri(e.target.value)} className={field} />
              </div>
              <div className="self-end">
                <Button size="sm" disabled={!hasModelInput || busy} onClick={() => void run(async () => { await addEquipmentModel({ partId: part.id, make, model, ahri }); setMake(''); setModel(''); setAhri(''); await loadLinks(part); }, 'Equipment link added.')}>Add</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function AuditCard() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setRows(await listAudit(30));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the audit trail.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className={card} aria-labelledby="ps-audit">
      <h2 id="ps-audit" className="text-base font-semibold text-text-primary">Recent changes</h2>
      {error && <div className="mt-3"><ErrorNote message={error} onRetry={() => void load()} /></div>}
      {!rows && !error && <LoadingRow />}
      {rows && rows.length === 0 && <div className="mt-3"><EmptyState>No changes recorded yet.</EmptyState></div>}
      {rows && rows.length > 0 && (
        <ul className="mt-3 divide-y divide-border text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate text-text-primary">{r.action.replace(/_/g, ' ')}{r.target_table ? <span className="text-xs text-text-secondary"> · {r.target_table}</span> : null}</span>
              <time dateTime={r.created_at} className="shrink-0 text-xs text-text-secondary">{new Date(r.created_at).toLocaleString()}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
