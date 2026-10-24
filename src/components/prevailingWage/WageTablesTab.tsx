import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, FileSpreadsheet, Lock, Pencil, Plus, Table2, Trash2, Upload } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  CONSTRUCTION_LABEL,
  PROGRAM_LABEL,
  deleteDetermination,
  deleteRate,
  fetchRates,
  importRates,
  saveDetermination,
  saveRate,
  setDeterminationReview,
  type ConstructionType,
  type Determination,
  type DeterminationStatus,
  type Program,
  type WageRateRow,
} from '@/lib/prevailingWageApi';
import { centsToInput, formatMoney, parseMoneyToCents, validateRateInput, isIsoDate } from '@/lib/prevailingWage';
import { parseRatesCsv, type ImportedRate } from '@/lib/prevailingWageExport';
import { Pill, ReviewBadge, ReviewControl, SectionTitle, Select, errMsg, todayIso } from './shared';

interface Props {
  canEdit: boolean;
  determinations: Determination[];
  loading: boolean;
  reload: () => Promise<void>;
}

interface DetForm {
  id?: string;
  name: string;
  program: Program;
  determinationNumber: string;
  revision: string;
  state: string;
  county: string;
  locality: string;
  constructionType: ConstructionType;
  effectiveFrom: string;
  effectiveTo: string;
  sourceUrl: string;
  sourceNotes: string;
  status: DeterminationStatus;
}

interface RateForm {
  id?: string;
  classification: string;
  base: string;
  fringe: string;
  effectiveFrom: string;
  effectiveTo: string;
  isApprentice: boolean;
  otOverride: string;
  tradeCode: string | null;
  notes: string | null;
}

const emptyDet = (): DetForm => ({
  name: '',
  program: 'davis_bacon',
  determinationNumber: '',
  revision: '',
  state: '',
  county: '',
  locality: '',
  constructionType: 'building',
  effectiveFrom: todayIso(),
  effectiveTo: '',
  sourceUrl: '',
  sourceNotes: '',
  status: 'draft',
});

const emptyRate = (from: string): RateForm => ({
  classification: '',
  base: '',
  fringe: '0.00',
  effectiveFrom: from,
  effectiveTo: '',
  isApprentice: false,
  otOverride: '',
  tradeCode: null,
  notes: null,
});

export function WageTablesTab({ canEdit, determinations, loading, reload }: Props) {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rates, setRates] = useState<WageRateRow[]>([]);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detForm, setDetForm] = useState<DetForm | null>(null);
  const [detError, setDetError] = useState<string | null>(null);
  const [rateForm, setRateForm] = useState<RateForm | null>(null);
  const [rateError, setRateError] = useState<string | null>(null);
  const [deletingDet, setDeletingDet] = useState<Determination | null>(null);
  const [deletingRate, setDeletingRate] = useState<WageRateRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importFrom, setImportFrom] = useState(todayIso());
  const [importPreview, setImportPreview] = useState<{ rows: ImportedRate[]; errors: string[] } | null>(null);

  const selected = useMemo(() => determinations.find((d) => d.id === selectedId) ?? null, [determinations, selectedId]);

  useEffect(() => {
    if (!selectedId && determinations.length > 0) setSelectedId(determinations[0].id);
    if (selectedId && !determinations.some((d) => d.id === selectedId)) setSelectedId(determinations[0]?.id ?? null);
  }, [determinations, selectedId]);

  const loadRates = useCallback(async (id: string) => {
    setRatesLoading(true);
    try {
      setRates(await fetchRates(id));
    } catch (e) {
      toast(errMsg(e, 'Could not load rates.'), 'error');
    } finally {
      setRatesLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    setRateForm(null);
    setImportOpen(false);
    setImportPreview(null);
    if (selectedId) void loadRates(selectedId);
    else setRates([]);
  }, [selectedId, loadRates]);

  const locked = Boolean(selected?.lockedAt);

  const submitDetermination = async () => {
    if (!detForm) return;
    if (!detForm.name.trim()) return setDetError('Give the wage table a name.');
    if (!isIsoDate(detForm.effectiveFrom)) return setDetError('Enter a valid effective-from date.');
    if (detForm.effectiveTo && (!isIsoDate(detForm.effectiveTo) || detForm.effectiveTo < detForm.effectiveFrom)) return setDetError('Effective-to must be a valid date on or after effective-from.');
    if (detForm.state && !/^[A-Za-z]{2,3}$/.test(detForm.state.trim())) return setDetError('Use a 2-letter state code, for example CA.');
    setBusy(true);
    setDetError(null);
    try {
      await saveDetermination({
        id: detForm.id,
        name: detForm.name,
        program: detForm.program,
        determinationNumber: detForm.determinationNumber || null,
        revision: detForm.revision || null,
        country: 'US',
        state: detForm.state || null,
        county: detForm.county || null,
        locality: detForm.locality || null,
        constructionType: detForm.constructionType,
        effectiveFrom: detForm.effectiveFrom,
        effectiveTo: detForm.effectiveTo || null,
        sourceUrl: detForm.sourceUrl || null,
        sourceNotes: detForm.sourceNotes || null,
        status: detForm.status,
      });
      toast('Wage table saved. Legal review was reset if rates or terms changed.', 'success');
      setDetForm(null);
      await reload();
    } catch (e) {
      setDetError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const submitRate = async () => {
    if (!rateForm || !selected) return;
    const baseRateCents = parseMoneyToCents(rateForm.base);
    const fringeCents = parseMoneyToCents(rateForm.fringe === '' ? '0' : rateForm.fringe);
    const otOverride = rateForm.otOverride.trim() === '' ? null : Number(rateForm.otOverride);
    const problem = validateRateInput({
      classification: rateForm.classification,
      baseRateCents,
      fringeCents,
      effectiveFrom: rateForm.effectiveFrom,
      effectiveTo: rateForm.effectiveTo || null,
      otMultiplierOverride: otOverride,
    });
    if (problem) return setRateError(problem);
    setBusy(true);
    setRateError(null);
    try {
      await saveRate({
        id: rateForm.id,
        determinationId: selected.id,
        classification: rateForm.classification,
        tradeCode: rateForm.tradeCode,
        effectiveFrom: rateForm.effectiveFrom,
        effectiveTo: rateForm.effectiveTo || null,
        baseRateCents: baseRateCents as number,
        fringeCents: fringeCents as number,
        isApprentice: rateForm.isApprentice,
        otMultiplierOverride: otOverride,
        notes: rateForm.notes,
      });
      toast('Rate saved.', 'success');
      setRateForm(null);
      await Promise.all([loadRates(selected.id), reload()]);
    } catch (e) {
      setRateError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const setReview = async (status: 'unreviewed' | 'in_review' | 'approved', reviewer: string) => {
    if (!selected) return;
    setBusy(true);
    try {
      await setDeterminationReview(selected.id, status, reviewer);
      toast(status === 'approved' ? 'Marked as legally reviewed.' : 'Review status updated.', 'success');
      await reload();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const runImportPreview = () => setImportPreview(parseRatesCsv(importText, importFrom));

  const runImport = async () => {
    if (!selected || !importPreview || importPreview.rows.length === 0) return;
    setBusy(true);
    try {
      const r = await importRates(selected.id, importPreview.rows);
      toast(`Imported ${r.inserted} rate${r.inserted === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped} that already exist` : ''}.`, 'success');
      setImportOpen(false);
      setImportText('');
      setImportPreview(null);
      await Promise.all([loadRates(selected.id), reload()]);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const editDet = (d: Determination) =>
    setDetForm({
      id: d.id,
      name: d.name,
      program: d.program,
      determinationNumber: d.determinationNumber ?? '',
      revision: d.revision ?? '',
      state: d.state ?? '',
      county: d.county ?? '',
      locality: d.locality ?? '',
      constructionType: d.constructionType,
      effectiveFrom: d.effectiveFrom,
      effectiveTo: d.effectiveTo ?? '',
      sourceUrl: d.sourceUrl ?? '',
      sourceNotes: d.sourceNotes ?? '',
      status: d.status,
    });

  const editRate = (r: WageRateRow) =>
    setRateForm({
      id: r.id,
      classification: r.classification,
      base: centsToInput(r.baseRateCents),
      fringe: centsToInput(r.fringeCents),
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo ?? '',
      isApprentice: r.isApprentice,
      otOverride: r.otMultiplierOverride === null ? '' : String(r.otMultiplierOverride),
      tradeCode: r.tradeCode,
      notes: r.notes,
    });

  const confirmDeleteDet = async () => {
    if (!deletingDet) return;
    try {
      await deleteDetermination(deletingDet.id);
      toast('Wage table deleted.', 'success');
      setDeletingDet(null);
      await reload();
    } catch (e) {
      toast(errMsg(e), 'error');
      setDeletingDet(null);
    }
  };

  const confirmDeleteRate = async () => {
    if (!deletingRate || !selected) return;
    try {
      await deleteRate(deletingRate.id);
      toast('Rate deleted.', 'success');
      setDeletingRate(null);
      await Promise.all([loadRates(selected.id), reload()]);
    } catch (e) {
      toast(errMsg(e), 'error');
      setDeletingRate(null);
    }
  };

  if (loading) return <SkeletonCardList count={3} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle hint="One wage table per determination or agreement. Rates are effective-dated, so mid-contract increases are just another row.">Wage tables</SectionTitle>
        {canEdit && (
          <Button size="sm" onClick={() => { setDetError(null); setDetForm(emptyDet()); }}>
            <Plus size={14} /> New wage table
          </Button>
        )}
      </div>

      {determinations.length === 0 && !detForm ? (
        <EmptyState
          icon={Table2}
          title="No wage tables yet"
          description="Create a wage table for a Davis-Bacon, state or city determination, then add classification rates."
          action={canEdit ? { label: 'New wage table', onClick: () => { setDetError(null); setDetForm(emptyDet()); } } : undefined}
        />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {determinations.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setSelectedId(d.id)}
              aria-pressed={d.id === selectedId}
              className={`focus-ring rounded-2xl border p-4 text-left transition-colors ${d.id === selectedId ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'}`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="truncate text-sm font-semibold text-text-primary">{d.name}</p>
                {d.lockedAt && <Lock size={14} className="shrink-0 text-text-secondary" aria-label="Locked by a certified payroll" />}
              </div>
              <p className="mt-0.5 truncate text-xs text-text-secondary">
                {PROGRAM_LABEL[d.program]}{d.state ? ` · ${d.state}` : ''}{d.county ? ` · ${d.county}` : ''}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <ReviewBadge status={d.legalReviewStatus} />
                {d.status !== 'active' && <Pill tone={d.status === 'archived' ? 'neutral' : 'warn'}>{d.status === 'archived' ? 'Archived' : 'Draft'}</Pill>}
              </div>
            </button>
          ))}
        </div>
      )}

      {detForm && (
        <Card className="p-4 sm:p-5">
          <SectionTitle>{detForm.id ? 'Edit wage table' : 'New wage table'}</SectionTitle>
          {detForm.id && locked && (
            <p className="mb-3 rounded-xl bg-warning-500/10 p-3 text-xs text-text-primary">
              This wage table is locked by a certified payroll. Only its status and notes can change — add a new effective-dated rate for increases.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Input label="Name" value={detForm.name} onChange={(e) => setDetForm({ ...detForm, name: e.target.value })} maxLength={200} required />
            <Select label="Program" value={detForm.program} onChange={(e) => setDetForm({ ...detForm, program: e.target.value as Program })}>
              {Object.entries(PROGRAM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Select label="Construction type" value={detForm.constructionType} onChange={(e) => setDetForm({ ...detForm, constructionType: e.target.value as ConstructionType })}>
              {Object.entries(CONSTRUCTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Input label="Determination number" value={detForm.determinationNumber} onChange={(e) => setDetForm({ ...detForm, determinationNumber: e.target.value })} maxLength={80} />
            <Input label="Revision / modification" value={detForm.revision} onChange={(e) => setDetForm({ ...detForm, revision: e.target.value })} maxLength={80} />
            <Input label="State" value={detForm.state} onChange={(e) => setDetForm({ ...detForm, state: e.target.value.toUpperCase() })} maxLength={3} helperText="2-letter code" />
            <Input label="County" value={detForm.county} onChange={(e) => setDetForm({ ...detForm, county: e.target.value })} maxLength={120} />
            <Input label="City / locality" value={detForm.locality} onChange={(e) => setDetForm({ ...detForm, locality: e.target.value })} maxLength={120} />
            <Select label="Status" value={detForm.status} onChange={(e) => setDetForm({ ...detForm, status: e.target.value as DeterminationStatus })}>
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </Select>
            <Input label="Effective from" type="date" value={detForm.effectiveFrom} onChange={(e) => setDetForm({ ...detForm, effectiveFrom: e.target.value })} required />
            <Input label="Effective to (optional)" type="date" value={detForm.effectiveTo} onChange={(e) => setDetForm({ ...detForm, effectiveTo: e.target.value })} />
            <Input label="Source link" type="url" value={detForm.sourceUrl} onChange={(e) => setDetForm({ ...detForm, sourceUrl: e.target.value })} maxLength={500} placeholder="https://" />
          </div>
          <div className="mt-4">
            <Textarea label="Notes" rows={2} value={detForm.sourceNotes} onChange={(e) => setDetForm({ ...detForm, sourceNotes: e.target.value })} maxLength={2000} />
          </div>
          {detError && <p role="alert" className="mt-3 text-sm text-danger">{detError}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" onClick={submitDetermination} disabled={busy}>Save wage table</Button>
            <Button size="sm" variant="ghost" onClick={() => setDetForm(null)} disabled={busy}>Cancel</Button>
          </div>
        </Card>
      )}

      {selected && (
        <div className="space-y-4">
          <Card className="p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold text-text-primary">{selected.name}</h3>
                <p className="text-xs text-text-secondary">
                  {[selected.determinationNumber, selected.revision].filter(Boolean).join(' · ') || 'No determination number'} · effective {selected.effectiveFrom}
                  {selected.effectiveTo ? ` to ${selected.effectiveTo}` : ' (open-ended)'}
                </p>
                {selected.sourceUrl && (
                  <a href={selected.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline">Source</a>
                )}
              </div>
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => { setDetError(null); editDet(selected); }}><Pencil size={14} /> Edit</Button>
                  {selected.status !== 'archived' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await saveDetermination({ ...selected, status: 'archived' });
                          await reload();
                        } catch (e) {
                          toast(errMsg(e), 'error');
                        } finally {
                          setBusy(false);
                        }
                      }}
                      disabled={busy}
                    >
                      <Archive size={14} /> Archive
                    </Button>
                  )}
                  {!locked && <Button size="sm" variant="ghost" onClick={() => setDeletingDet(selected)}><Trash2 size={14} /> Delete</Button>}
                </div>
              )}
            </div>
            <div className="mt-4">
              <ReviewControl
                status={selected.legalReviewStatus}
                reviewedBy={selected.legalReviewedBy}
                reviewedAt={selected.legalReviewedAt}
                canEdit={canEdit}
                busy={busy}
                onSet={setReview}
              />
            </div>
          </Card>

          <Card className="p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SectionTitle hint={locked ? 'Locked: add a new effective-dated row for any change.' : 'Base + fringe are hourly. Add the same classification again with a later date for scheduled increases.'}>
                Classification rates ({rates.length})
              </SectionTitle>
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => { setImportOpen((v) => !v); setImportPreview(null); }}>
                    <Upload size={14} /> Paste / import
                  </Button>
                  <Button size="sm" onClick={() => { setRateError(null); setRateForm(emptyRate(selected.effectiveFrom)); }}>
                    <Plus size={14} /> Add rate
                  </Button>
                </div>
              )}
            </div>

            {importOpen && (
              <div className="mb-4 rounded-xl border border-border bg-bg-primary p-4">
                <p className="text-xs text-text-secondary">
                  Paste rows from a spreadsheet or the wage determination: <span className="font-mono">classification, base rate, fringe, [effective date], [apprentice]</span>. Comma or tab separated.
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_200px]">
                  <Textarea label="Rows" rows={5} value={importText} onChange={(e) => { setImportText(e.target.value); setImportPreview(null); }} placeholder={'Electrician - Journeyman, 45.50, 15.20\nLaborer, 30.00, 10.75'} />
                  <Input label="Default effective date" type="date" value={importFrom} onChange={(e) => { setImportFrom(e.target.value); setImportPreview(null); }} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={runImportPreview} disabled={!importText.trim() || !isIsoDate(importFrom)}>Check rows</Button>
                  <Button size="sm" onClick={runImport} disabled={busy || !importPreview || importPreview.rows.length === 0}>
                    <FileSpreadsheet size={14} /> Import {importPreview?.rows.length ?? 0} rate{importPreview?.rows.length === 1 ? '' : 's'}
                  </Button>
                </div>
                {importPreview && (
                  <div className="mt-3 text-sm" aria-live="polite">
                    <p className="text-text-primary">{importPreview.rows.length} valid row{importPreview.rows.length === 1 ? '' : 's'}.</p>
                    {importPreview.errors.length > 0 && (
                      <ul className="mt-1 list-disc pl-5 text-xs text-danger">
                        {importPreview.errors.slice(0, 8).map((m) => <li key={m}>{m}</li>)}
                        {importPreview.errors.length > 8 && <li>…and {importPreview.errors.length - 8} more</li>}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}

            {rateForm && (
              <div className="mb-4 rounded-xl border border-border bg-bg-primary p-4">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="sm:col-span-2">
                    <Input label="Classification" value={rateForm.classification} onChange={(e) => setRateForm({ ...rateForm, classification: e.target.value })} maxLength={200} disabled={Boolean(rateForm.id) && locked} required />
                  </div>
                  <Input label="Base rate ($/hr)" inputMode="decimal" value={rateForm.base} onChange={(e) => setRateForm({ ...rateForm, base: e.target.value })} required />
                  <Input label="Fringe ($/hr)" inputMode="decimal" value={rateForm.fringe} onChange={(e) => setRateForm({ ...rateForm, fringe: e.target.value })} />
                  <Input label="Effective from" type="date" value={rateForm.effectiveFrom} onChange={(e) => setRateForm({ ...rateForm, effectiveFrom: e.target.value })} required />
                  <Input label="Effective to (optional)" type="date" value={rateForm.effectiveTo} onChange={(e) => setRateForm({ ...rateForm, effectiveTo: e.target.value })} />
                  <Input label="OT multiplier override" inputMode="decimal" value={rateForm.otOverride} onChange={(e) => setRateForm({ ...rateForm, otOverride: e.target.value })} helperText="Blank = use the rule set" />
                  <label className="flex items-center gap-2 self-end pb-3 text-sm text-text-primary">
                    <input type="checkbox" checked={rateForm.isApprentice} onChange={(e) => setRateForm({ ...rateForm, isApprentice: e.target.checked })} className="h-4 w-4 accent-accent" />
                    Apprentice rate
                  </label>
                </div>
                {rateError && <p role="alert" className="mt-3 text-sm text-danger">{rateError}</p>}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" onClick={submitRate} disabled={busy}>Save rate</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRateForm(null)} disabled={busy}>Cancel</Button>
                </div>
              </div>
            )}

            {ratesLoading ? (
              <SkeletonCardList count={2} />
            ) : rates.length === 0 ? (
              <EmptyState icon={Table2} title="No rates yet" description="Add classification rates one by one, or paste a table from a spreadsheet." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-text-secondary">
                      <th className="py-2 pr-3 font-semibold">Classification</th>
                      <th className="py-2 pr-3 font-semibold">Effective</th>
                      <th className="py-2 pr-3 text-right font-semibold">Base</th>
                      <th className="py-2 pr-3 text-right font-semibold">Fringe</th>
                      <th className="py-2 pr-3 text-right font-semibold">Total</th>
                      <th className="py-2 pr-3 font-semibold">Notes</th>
                      <th className="py-2"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rates.map((r) => (
                      <tr key={r.id} className="border-b border-border/60 align-top">
                        <td className="py-2 pr-3 font-medium text-text-primary">{r.classification}</td>
                        <td className="py-2 pr-3 whitespace-nowrap text-text-secondary">{r.effectiveFrom}{r.effectiveTo ? ` → ${r.effectiveTo}` : ' →'}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(r.baseRateCents)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(r.fringeCents)}</td>
                        <td className="py-2 pr-3 text-right font-semibold tabular-nums">{formatMoney(r.baseRateCents + r.fringeCents)}</td>
                        <td className="py-2 pr-3">
                          <div className="flex flex-wrap gap-1">
                            {r.isApprentice && <Pill tone="accent">Apprentice</Pill>}
                            {r.otMultiplierOverride !== null && <Pill>OT ×{r.otMultiplierOverride}</Pill>}
                          </div>
                        </td>
                        <td className="py-2 text-right">
                          {canEdit && !locked && (
                            <div className="flex justify-end gap-1">
                              <button type="button" onClick={() => { setRateError(null); editRate(r); }} className="focus-ring rounded-lg p-2 text-text-secondary hover:text-text-primary" aria-label={`Edit ${r.classification}`}><Pencil size={14} /></button>
                              <button type="button" onClick={() => setDeletingRate(r)} className="focus-ring rounded-lg p-2 text-text-secondary hover:text-danger" aria-label={`Delete ${r.classification}`}><Trash2 size={14} /></button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={!!deletingDet}
        title="Delete this wage table?"
        description="All of its rates are deleted too. A wage table that is assigned to a job cannot be deleted."
        confirmLabel="Delete wage table"
        onConfirm={confirmDeleteDet}
        onCancel={() => setDeletingDet(null)}
      />
      <ConfirmDialog
        open={!!deletingRate}
        title="Delete this rate?"
        description="The wage table will need legal review again."
        confirmLabel="Delete rate"
        onConfirm={confirmDeleteRate}
        onCancel={() => setDeletingRate(null)}
      />
    </div>
  );
}
