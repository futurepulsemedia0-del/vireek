import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, FlaskConical, Pencil, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  fetchLogEntries,
  fetchProducts,
  friendlyTradePackError,
  saveProduct,
  setProductArchived,
  type ProductInput,
  type RegulatedProduct,
  type TradeLogEntry,
} from '@/lib/tradePacksApi';
import {
  EPA_REG_RE,
  KIND_LABELS,
  PESTICIDE_KINDS,
  PRODUCT_UNITS,
  UNIT_LABELS,
  computeStockBalance,
  CHEMICALS,
  CHEM_IDS,
  type ChemId,
  type ProductKind,
  type ProductUnit,
  type TradePack,
} from '@/lib/tradePacks';
import { Pill, SelectField } from './shared';

const EMPTY: ProductInput = {
  name: '', kind: 'other', unit: 'fl_oz', epa_reg_number: '', epa_exempt_25b: false, active_ingredient: '',
restricted_use: false, signal_word: '', label_max_rate: '', reentry_hours: '', sds_url: '', notes: '',
  chem_key: '', strength_pct: '',
};

const toForm = (p: RegulatedProduct): ProductInput => ({
  name: p.name, kind: p.kind, unit: p.unit, epa_reg_number: p.epa_reg_number ?? '', epa_exempt_25b: p.epa_exempt_25b,
  active_ingredient: p.active_ingredient ?? '', restricted_use: p.restricted_use, signal_word: p.signal_word ?? '',
  label_max_rate: p.label_max_rate == null ? '' : String(p.label_max_rate), reentry_hours: p.reentry_hours == null ? '' : String(p.reentry_hours),
  sds_url: p.sds_url ?? '', notes: p.notes ?? '',
  chem_key: p.chem_key ?? '', strength_pct: p.strength_pct == null ? '' : String(p.strength_pct),
});

export function ProductRegisterPanel({ pack, ownerId, canManage }: { pack: TradePack; ownerId: string; canManage: boolean }) {
  const { toast } = useToast();
  const [products, setProducts] = useState<RegulatedProduct[]>([]);
  const [entries, setEntries] = useState<TradeLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<ProductInput>(EMPTY);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const isPest = pack.key === 'pest_control';
  const kinds = pack.productKinds;
  const needsEpa = isPest && PESTICIDE_KINDS.includes(form.kind);

  const load = useCallback(async () => {
    try {
      const [p, e] = await Promise.all([
        fetchProducts(ownerId, pack.key, showArchived),
        fetchLogEntries(ownerId, { packKey: pack.key, limit: 1000 }),
      ]);
      setProducts(p);
      setEntries(e);
    } catch (err) {
      toast(friendlyTradePackError(err, 'Could not load products.'), 'error');
    } finally {
      setLoading(false);
    }
  }, [ownerId, pack.key, showArchived, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const balances = useMemo(() => {
    const m = new Map<string, ReturnType<typeof computeStockBalance>>();
    for (const p of products) m.set(p.id, computeStockBalance(entries, p.id, p.unit));
    return m;
  }, [products, entries]);

  const open = (p?: RegulatedProduct) => {
    setEditing(p ? p.id : 'new');
    setForm(p ? toForm(p) : { ...EMPTY, kind: kinds[0] ?? 'other' });
    setErrors([]);
  };

  const validate = (): string[] => {
    const e: string[] = [];
    if (!form.name.trim()) e.push('Name is required');
    if (needsEpa && !form.epa_exempt_25b && !EPA_REG_RE.test(form.epa_reg_number.trim())) e.push('Enter the EPA registration number (e.g. 432-1217) or mark the product 25(b) exempt');
    if (form.epa_reg_number.trim() && !EPA_REG_RE.test(form.epa_reg_number.trim())) e.push('EPA registration number format is 1234-567 or 1234-567-89');
    if (form.label_max_rate.trim() && !(Number(form.label_max_rate) > 0)) e.push('Label maximum rate must be a positive number');
    if (form.reentry_hours.trim() && !(Number(form.reentry_hours) >= 0)) e.push('Re-entry hours must be 0 or more');
    if (form.sds_url.trim() && !/^https?:\/\//i.test(form.sds_url.trim())) e.push('SDS link must start with http(s)://');
    if (form.chem_key) {
      const def = CHEMICALS[form.chem_key];
      const pct = Number(form.strength_pct);
      if (!form.strength_pct?.trim() || !Number.isFinite(pct) || pct < def.minStrengthPct || pct > def.maxStrengthPct) e.push(`Strength for ${def.label} must be between ${def.minStrengthPct}% and ${def.maxStrengthPct}%`);
    }
    return e;
  };

  const save = async () => {
    const problems = validate();
    setErrors(problems);
    if (problems.length) return;
    setSaving(true);
    try {
      await saveProduct(ownerId, pack.key, form, editing && editing !== 'new' ? editing : undefined);
      toast('Product saved.', 'success');
      setEditing(null);
      await load();
    } catch (err) {
      setErrors([friendlyTradePackError(err, 'Could not save the product.')]);
    } finally {
      setSaving(false);
    }
  };

  const archive = async (p: RegulatedProduct) => {
    try {
      await setProductArchived(ownerId, p.id, !p.archived_at);
      await load();
    } catch (err) {
      toast(friendlyTradePackError(err), 'error');
    }
  };

  const set = <K extends keyof ProductInput>(k: K, v: ProductInput[K]) => setForm((s) => ({ ...s, [k]: v }));

  if (loading) return <Skeleton className="h-40 w-full rounded-2xl" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
        {canManage && editing === null && <Button onClick={() => open()}>Add product</Button>}
      </div>

      {editing !== null && (
        <Card className="space-y-4 p-6">
          <h3 className="text-base font-semibold text-text-primary">{editing === 'new' ? 'New product' : 'Edit product'}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Product name" required value={form.name} onChange={(e) => set('name', e.target.value)} />
            <SelectField label="Type" value={form.kind} onChange={(v) => set('kind', v as ProductKind)}>
              {kinds.map((k) => (
                <option key={k} value={k}>{KIND_LABELS[k]}</option>
              ))}
            </SelectField>
            <SelectField label="Unit used in logs" value={form.unit} onChange={(v) => set('unit', v as ProductUnit)}>
              {PRODUCT_UNITS.map((u) => (
                <option key={u} value={u}>{UNIT_LABELS[u]}</option>
              ))}
            </SelectField>
            <Input label="Active ingredient" value={form.active_ingredient} onChange={(e) => set('active_ingredient', e.target.value)} />
            {pack.key === 'pool_service' && (
              <>
                <SelectField
                  label="Chemical (for dosing recommendations)"
                  value={form.chem_key ?? ''}
                  helperText="Pick what this product is so water-chemistry doses can be calculated and logged with it."
                  onChange={(v) => {
                    const id = v as ChemId | '';
                    setForm((s) => ({
                      ...s,
                      chem_key: id,
                      strength_pct: id ? String(CHEMICALS[id].defaultStrengthPct) : '',
                      kind: id ? CHEMICALS[id].kind : s.kind,
                      unit: id ? (CHEMICALS[id].form === 'liquid' ? 'fl_oz' : 'oz') : s.unit,
                    }));
                  }}
                >
                  <option value="">Not used for recommendations</option>
                  {CHEM_IDS.map((id) => (
                    <option key={id} value={id}>{CHEMICALS[id].label}</option>
                  ))}
                </SelectField>
                {form.chem_key && (
                  <Input label="Strength (%)" type="number" step="any" helperText={CHEMICALS[form.chem_key].strengthHelp} value={form.strength_pct ?? ''} onChange={(e) => set('strength_pct', e.target.value)} />
                )}
              </>
            )}
            {isPest && (
              <>
                <Input label="EPA registration no." required={needsEpa && !form.epa_exempt_25b} placeholder="432-1217" value={form.epa_reg_number} onChange={(e) => set('epa_reg_number', e.target.value)} />
                <SelectField label="Signal word" value={form.signal_word} onChange={(v) => set('signal_word', v as ProductInput['signal_word'])}>
                  <option value="">—</option>
                  <option value="danger">Danger</option>
                  <option value="warning">Warning</option>
                  <option value="caution">Caution</option>
                </SelectField>
                <Input label={`Label max rate (${UNIT_LABELS[form.unit]} per 1,000 sq ft)`} type="number" step="any" helperText="Leave empty for no limit. If set, logs must include the treated area." value={form.label_max_rate} onChange={(e) => set('label_max_rate', e.target.value)} />
                <Input label="Re-entry interval (hours)" type="number" step="any" value={form.reentry_hours} onChange={(e) => set('reentry_hours', e.target.value)} />
              </>
            )}
            <Input label="Safety data sheet link" placeholder="https://" value={form.sds_url} onChange={(e) => set('sds_url', e.target.value)} />
          </div>
          {isPest && (
            <div className="flex flex-wrap gap-6 text-sm text-text-primary">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.restricted_use} onChange={(e) => set('restricted_use', e.target.checked)} /> Restricted-use pesticide
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.epa_exempt_25b} onChange={(e) => set('epa_exempt_25b', e.target.checked)} /> EPA 25(b) exempt (no registration number)
              </label>
            </div>
          )}
          <Textarea label="Notes" rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          {errors.length > 0 && (
            <ul className="space-y-1 text-sm text-danger" role="alert">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={save} disabled={saving}>Save product</Button>
          </div>
        </Card>
      )}

      {products.length === 0 ? (
        <EmptyState icon={FlaskConical} title="No products registered" description="Register every product you use. Logs can only reference registered products, so labels, EPA numbers and licence rules are enforced." />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {products.map((p) => {
            const b = balances.get(p.id);
            return (
              <li key={p.id} className={`rounded-xl border border-border bg-bg-secondary p-4 text-sm ${p.archived_at ? 'opacity-60' : ''}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-text-primary">{p.name}</p>
                    <p className="text-text-secondary">{KIND_LABELS[p.kind]}{p.active_ingredient ? ` · ${p.active_ingredient}` : ''}</p>
                  </div>
                  {canManage && (
                    <div className="flex gap-1">
                      <button type="button" aria-label={`Edit ${p.name}`} className="focus-ring rounded p-1 text-text-secondary hover:text-text-primary" onClick={() => open(p)}><Pencil size={14} /></button>
                      <button type="button" aria-label={p.archived_at ? `Restore ${p.name}` : `Archive ${p.name}`} className="focus-ring rounded p-1 text-text-secondary hover:text-text-primary" onClick={() => archive(p)}>
                        {p.archived_at ? <RotateCcw size={14} /> : <Archive size={14} />}
                      </button>
                    </div>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {p.epa_reg_number && <Pill>EPA {p.epa_reg_number}</Pill>}
                  {p.epa_exempt_25b && <Pill>25(b) exempt</Pill>}
                  {p.restricted_use && <Pill tone="warning">Restricted-use</Pill>}
                  {p.signal_word && <Pill tone={p.signal_word === 'danger' ? 'danger' : 'warning'}>{p.signal_word}</Pill>}
                  {p.label_max_rate != null && <Pill>max {p.label_max_rate} {UNIT_LABELS[p.unit]}/1,000 sq ft</Pill>}
                  {p.reentry_hours != null && <Pill>re-entry {p.reentry_hours} h</Pill>}
                  {p.chem_key && CHEMICALS[p.chem_key] && <Pill>{CHEMICALS[p.chem_key].label}{p.strength_pct != null ? ` · ${p.strength_pct}%` : ''}</Pill>}
                </div>
                {isPest && b && (
                  <p className="mt-2 text-text-secondary">
                    On hand (book): <span className="font-medium text-text-primary">{b.balance} {UNIT_LABELS[p.unit]}</span>
                    {b.unitMismatches > 0 && <span className="text-warning"> · {b.unitMismatches} entr{b.unitMismatches === 1 ? 'y' : 'ies'} in another unit not counted</span>}
                  </p>
                )}
                {p.sds_url && (
                  <a href={p.sds_url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-accent hover:underline">Safety data sheet</a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
