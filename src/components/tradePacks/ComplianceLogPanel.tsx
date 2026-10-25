import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Ban, Download, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';
import {
  addLogEntry,
  fetchCustomerEquipment,
  fetchLogEntries,
  fetchProducts,
  fetchTeam,
  friendlyTradePackError,
  ledgerToCsv,
  voidLogEntry,
  type EquipmentOption,
  type PackInstall,
  type RegulatedProduct,
  type TeamOption,
  type TradeLogEntry,
} from '@/lib/tradePacksApi';
import {
  CHEM_RANGES,
  checkLabelRate,
  cleanLogData,
  evaluateChemistry,
  getLogType,
  langelierIndex,
  saturation,
  validateLogData,
  type ChemKey,
  type ChemReadings,
  type LogData,
  type LogFieldDef,
  type TradePack,
} from '@/lib/tradePacks';
import { Pill, SelectField, fmtDate, fmtDateTime, localInputToISO, nowLocalInput } from './shared';

export interface LogJobContext {
  id: string;
  customer_id?: string | null;
  assigned_technician_id?: string | null;
}

interface Props {
  pack: TradePack;
  ownerId: string;
  install?: PackInstall;
  /** When set, entries are logged against this job (and only this job's entries are listed). */
  job?: LogJobContext;
  onChanged?: () => void;
}

function FieldInput({ f, value, onChange }: { f: LogFieldDef; value: unknown; onChange: (v: unknown) => void }) {
  const label = f.unit && !f.label.includes(f.unit) ? `${f.label} (${f.unit})` : f.label;
  switch (f.type) {
    case 'number':
      return (
        <Input
          label={label}
          type="number"
          inputMode="decimal"
          step="any"
          required={f.required}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      );
    case 'textarea':
      return <Textarea label={label} rows={3} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
    case 'boolean':
      return (
        <SelectField label={label} required={f.required} value={value === true ? 'yes' : value === false ? 'no' : ''} onChange={(v) => onChange(v === '' ? undefined : v === 'yes')}>
          <option value="">—</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </SelectField>
      );
    case 'select':
      return (
        <SelectField label={label} required={f.required} value={typeof value === 'string' ? value : ''} onChange={(v) => onChange(v || undefined)}>
          <option value="">Select…</option>
          {(f.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </SelectField>
      );
    case 'multiselect': {
      const sel = Array.isArray(value) ? (value as string[]) : [];
      return (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-text-primary">
            {label}
            {f.required && <span className="ml-0.5 text-danger">*</span>}
          </legend>
          <div className="flex flex-wrap gap-2">
            {(f.options ?? []).map((o) => {
              const on = sel.includes(o);
              return (
                <button
                  key={o}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange(on ? sel.filter((x) => x !== o) : [...sel, o])}
                  className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium transition-colors ${on ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:border-accent/40'}`}
                >
                  {o}
                </button>
              );
            })}
          </div>
        </fieldset>
      );
    }
    default:
      return <Input label={label} required={f.required} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

function summarize(entry: TradeLogEntry, pack: TradePack): string {
  const type = getLogType(pack, entry.entry_type);
  if (!type) return '';
  return type.fields
    .filter((f) => entry.data[f.key] !== undefined && entry.data[f.key] !== null)
    .map((f) => {
      const v = entry.data[f.key];
      const shown = typeof v === 'boolean' ? (v ? 'yes' : 'no') : Array.isArray(v) ? v.join(', ') : String(v);
      return `${f.label.replace(/\s*\(.*\)$/, '')}: ${shown}`;
    })
    .join(' · ');
}

export function ComplianceLogPanel({ pack, ownerId, install, job, onChanged }: Props) {
  const { toast } = useToast();
  const { isOwner } = useAuth();
  const types = useMemo(() => (job ? pack.logTypes : pack.logTypes.filter((t) => !t.requiresJob)), [pack, job]);

  const [entries, setEntries] = useState<TradeLogEntry[]>([]);
  const [products, setProducts] = useState<RegulatedProduct[]>([]);
  const [team, setTeam] = useState<TeamOption[]>([]);
  const [equipment, setEquipment] = useState<EquipmentOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [typeKey, setTypeKey] = useState(types[0]?.key ?? '');
  const [values, setValues] = useState<LogData>({});
  const [productId, setProductId] = useState('');
  const [technicianId, setTechnicianId] = useState(job?.assigned_technician_id ?? '');
  const [equipmentId, setEquipmentId] = useState('');
  const [performedAt, setPerformedAt] = useState(nowLocalInput());
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [voidId, setVoidId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');

  const type = getLogType(pack, typeKey);
  const product = products.find((p) => p.id === productId);

  const load = useCallback(async () => {
    try {
      const [e, p, t] = await Promise.all([
        fetchLogEntries(ownerId, { packKey: pack.key, jobId: job?.id, limit: 200 }),
        fetchProducts(ownerId, pack.key),
        fetchTeam(ownerId),
      ]);
      setEntries(e);
      setProducts(p);
      setTeam(t);
    } catch (err) {
      toast(friendlyTradePackError(err, 'Could not load records.'), 'error');
    } finally {
      setLoading(false);
    }
  }, [ownerId, pack.key, job?.id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!job?.customer_id) return;
    fetchCustomerEquipment(ownerId, job.customer_id).then(setEquipment).catch(() => setEquipment([]));
  }, [ownerId, job?.customer_id]);

  const reset = () => {
    setValues({});
    setProductId('');
    setEquipmentId('');
    setNotes('');
    setErrors([]);
    setPerformedAt(nowLocalInput());
  };

  const rate = useMemo(
    () => (type?.key === 'chemical_application' && product?.label_max_rate != null ? checkLabelRate(product, values.amount, values.amount_unit, values.area_sqft) : null),
    [type?.key, product, values.amount, values.amount_unit, values.area_sqft],
  );
  const chem = useMemo(() => {
    if (type?.key !== 'chemistry_reading') return null;
    const r = values as unknown as ChemReadings;
    const lsi = langelierIndex(r);
    return { ev: evaluateChemistry(r), lsi, sat: lsi === null ? null : saturation(lsi) };
  }, [type?.key, values]);

  const submit = async () => {
    if (!type) return;
    const problems = validateLogData(type, cleanLogData(values));
    if (type.usesProduct && !productId) problems.push('Choose a product from the register');
    if (type.requiresTechnician && !technicianId) problems.push('Choose the technician');
    if (type.requiresEquipment && !equipmentId) problems.push('Choose the equipment');
    if (type.requiresJob && !job) problems.push('Open this from a job');
    if (rate && !rate.ok && rate.message) problems.push(rate.message);
    setErrors(problems);
    if (problems.length) return;
    setSaving(true);
    try {
      await addLogEntry(ownerId, {
        packKey: pack.key,
        entryType: type.key,
        jobId: job?.id ?? null,
        equipmentId: equipmentId || null,
        technicianId: technicianId || null,
        productId: type.usesProduct ? productId : null,
        performedAt: localInputToISO(performedAt),
        data: values,
        notes,
      });
      toast(`${type.label} recorded.`, 'success');
      reset();
      await load();
      onChanged?.();
    } catch (err) {
      setErrors([friendlyTradePackError(err, 'Could not save the entry.')]);
    } finally {
      setSaving(false);
    }
  };

  const doVoid = async () => {
    if (!voidId) return;
    setSaving(true);
    try {
      await voidLogEntry(voidId, voidReason);
      toast('Entry voided. It stays in the ledger.', 'success');
      setVoidId(null);
      setVoidReason('');
      await load();
      onChanged?.();
    } catch (err) {
      toast(friendlyTradePackError(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([ledgerToCsv(entries)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pack.key}-compliance-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <Skeleton className="h-40 w-full rounded-2xl" />;

  return (
    <div className="space-y-4">
      {type && (
        <Card className="space-y-4 p-6">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[14rem] flex-1">
              <SelectField label="Record type" value={typeKey} onChange={(v) => { setTypeKey(v); setValues({}); setErrors([]); setProductId(''); }}>
                {types.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </SelectField>
            </div>
            <Input label="When" type="datetime-local" value={performedAt} max={nowLocalInput()} onChange={(e) => setPerformedAt(e.target.value)} />
          </div>
          <p className="text-sm text-text-secondary">{type.description}</p>

          <div className="grid gap-3 sm:grid-cols-2">
            {type.requiresTechnician && (
              <SelectField label="Technician" required value={technicianId} onChange={setTechnicianId}>
                <option value="">Select…</option>
                {team.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.member_name ?? 'Unnamed'}
                  </option>
                ))}
              </SelectField>
            )}
            {type.usesProduct && (
              <SelectField label="Product" required value={productId} onChange={setProductId} helperText={products.length ? undefined : 'Add products in the Products tab first.'}>
                <option value="">Select…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.restricted_use ? ' (restricted-use)' : ''}
                  </option>
                ))}
              </SelectField>
            )}
            {(type.requiresEquipment || (job && equipment.length > 0 && type.key === 'equipment_service')) && (
              <SelectField label="Equipment" required={type.requiresEquipment} value={equipmentId} onChange={setEquipmentId} helperText={equipment.length ? undefined : 'This customer has no equipment on file.'}>
                <option value="">Select…</option>
                {equipment.map((e) => (
                  <option key={e.id} value={e.id}>
                    {[e.make, e.model, e.equipment_type].filter(Boolean).join(' ')}
                  </option>
                ))}
              </SelectField>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {type.fields.map((f) => (
              <div key={f.key} className={f.type === 'textarea' || f.type === 'multiselect' ? 'sm:col-span-2' : ''}>
                <FieldInput f={f} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
              </div>
            ))}
          </div>

          {product && (product.restricted_use || product.reentry_hours) && (
            <p className="flex items-start gap-2 text-sm text-warning">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                {product.restricted_use && 'Restricted-use product — only a technician with a restricted-use licence can log it. '}
                {product.reentry_hours ? `Re-entry interval: ${product.reentry_hours} h.` : ''}
              </span>
            </p>
          )}
          {rate && (
            <p className={`text-sm ${rate.ok ? 'text-success' : 'text-danger'}`}>
              {rate.ok ? `Applied rate ${rate.rate} per 1,000 sq ft — within the label maximum (${rate.max}).` : rate.message}
            </p>
          )}
          {chem && Object.keys(chem.ev.statuses).length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {(Object.keys(chem.ev.statuses) as ChemKey[]).map((k) => {
                const s = chem.ev.statuses[k]!;
                return (
                  <Pill key={k} tone={s === 'ok' ? 'success' : s.startsWith('critical') ? 'danger' : 'warning'}>
                    {CHEM_RANGES[k].label}: {s === 'ok' ? 'in range' : s.replace('critical_', 'critically ')}
                  </Pill>
                );
              })}
              {chem.ev.combinedChlorine !== null && chem.ev.combinedChlorine > 0.4 && <Pill tone="warning">Combined chlorine {chem.ev.combinedChlorine} ppm — shock</Pill>}
              {chem.lsi !== null && <Pill tone={chem.sat === 'balanced' ? 'success' : 'warning'}>LSI {chem.lsi} · {chem.sat}</Pill>}
            </div>
          )}

          <Textarea label="Notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />

          {errors.length > 0 && (
            <ul className="space-y-1 text-sm text-danger" role="alert">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {install && !install.enforce_credentials && type.requiredCredentials.length > 0 && (
            <p className="text-xs text-text-secondary">Licence enforcement is off for this pack — entries are recorded even without a valid licence.</p>
          )}
          <div className="flex justify-end">
            <Button onClick={submit} disabled={saving}>
              {saving && <Loader2 size={16} className="animate-spin" />}
              Record entry
            </Button>
          </div>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-text-primary">Ledger</h3>
        {entries.length > 0 && (
          <Button variant="secondary" size="sm" onClick={exportCsv}>
            <Download size={14} /> Export CSV
          </Button>
        )}
      </div>

      {entries.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No records yet" description="Entries are append-only: mistakes are voided with a reason, never edited or deleted." />
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => {
            const t = getLogType(pack, e.entry_type);
            return (
              <li key={e.id} className={`rounded-xl border border-border bg-bg-secondary p-4 text-sm ${e.voided_at ? 'opacity-60' : ''}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-text-primary">{t?.label ?? e.entry_type}</span>
                  <span className="text-text-secondary">{fmtDateTime(e.performed_at)}</span>
                  {e.technician_name && <Pill>{e.technician_name}</Pill>}
                  {e.product_name && <Pill tone={e.product_restricted ? 'warning' : 'neutral'}>{e.product_name}{e.product_epa_reg ? ` · EPA ${e.product_epa_reg}` : ''}</Pill>}
                  {e.credential_number && <Pill tone="success">Licence {e.credential_number}</Pill>}
                  {e.voided_at && <Pill tone="danger">Voided</Pill>}
                </div>
                <p className="mt-1 text-text-secondary">{summarize(e, pack)}</p>
                {e.equipment_label && <p className="text-text-secondary">Equipment: {e.equipment_label}</p>}
                {e.reentry_until && new Date(e.reentry_until) > new Date() && <p className="text-warning">Re-entry restricted until {fmtDateTime(e.reentry_until)}</p>}
                {e.notes && <p className="mt-1 text-text-primary">{e.notes}</p>}
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary">
                  <span>{e.site_address ? `${e.site_address} · ` : ''}Keep until {fmtDate(e.retain_until)}</span>
                  {e.voided_at ? (
                    <span>Reason: {e.void_reason}</span>
                  ) : (
                    isOwner && (
                      <button type="button" className="focus-ring inline-flex items-center gap-1 text-danger hover:underline" onClick={() => { setVoidId(e.id); setVoidReason(''); }}>
                        <Ban size={12} /> Void
                      </button>
                    )
                  )}
                </div>
                {voidId === e.id && (
                  <div className="mt-3 space-y-2 rounded-lg border border-danger/30 p-3">
                    <Input label="Reason (min 5 characters)" value={voidReason} onChange={(ev) => setVoidReason(ev.target.value)} />
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setVoidId(null)}>Cancel</Button>
                      <Button size="sm" onClick={doVoid} disabled={saving || voidReason.trim().length < 5}>Void entry</Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
