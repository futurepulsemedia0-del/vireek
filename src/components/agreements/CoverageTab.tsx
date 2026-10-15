import { useMemo, useState } from 'react';
import { Building2, ClipboardList, Cog, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import {
  COVERAGE_LEVEL_LABELS,
  COVERAGE_LEVEL_OPTIONS,
  COVERAGE_LEVEL_STYLES,
  SERVICE_COVERAGE_LABELS,
  SERVICE_COVERAGE_OPTIONS,
  deleteAgreementRow,
  equipmentLabel,
  formatDate,
  formatMoney,
  insertAgreementRow,
  insertAgreementRows,
  siteLabel,
  updateAgreementRow,
  warrantyGapEquipment,
  type AssetRow,
  type CoverageLevel,
  type ServiceCoverage,
  type ServiceRow,
} from '@/lib/serviceAgreement';
import { CheckField, DeleteConfirm, FormActions, KeyValue, Panel, Pill, RowActions, SelectField, centsToDollarsText, dollarsToCents, useInlineForm, type TabProps } from './AgreementUi';
import { useAgreementActions } from './useAgreementActions';

interface AssetForm {
  target: 'site' | 'equipment';
  site_id: string;
  equipment_id: string;
  coverage_level: CoverageLevel;
  notes: string;
}
const EMPTY_ASSET: AssetForm = { target: 'equipment', site_id: '', equipment_id: '', coverage_level: 'full', notes: '' };

interface ServiceForm {
  service_type: string;
  coverage: ServiceCoverage;
  labor_covered: boolean;
  parts_covered: boolean;
  discount: string;
  cap: string;
  notes: string;
}
const EMPTY_SERVICE: ServiceForm = { service_type: '', coverage: 'included', labor_covered: true, parts_covered: false, discount: '', cap: '', notes: '' };

export function CoverageTab({ data, canManage, canSeeMoney, ownerId, reload }: TabProps) {
  const { busy, run } = useAgreementActions(reload);
  const assetForm = useInlineForm<AssetForm>(EMPTY_ASSET);
  const serviceForm = useInlineForm<ServiceForm>(EMPTY_SERVICE);
  const [deletingAsset, setDeletingAsset] = useState<{ id: string; label: string } | null>(null);
  const [deletingService, setDeletingService] = useState<{ id: string; label: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const siteById = useMemo(() => new Map(data.sites.map((s) => [s.id, s])), [data.sites]);
  const equipmentById = useMemo(() => new Map(data.equipment.map((e) => [e.id, e])), [data.equipment]);
  const coveredEquipmentIds = useMemo(() => new Set(data.assets.map((a) => a.equipment_id).filter((x): x is string => !!x)), [data.assets]);
  const coveredSiteIds = useMemo(() => new Set(data.assets.filter((a) => !a.equipment_id && a.site_id).map((a) => a.site_id as string)), [data.assets]);
  const uncoveredEquipment = data.equipment.filter((e) => !coveredEquipmentIds.has(e.id));
  const uncoveredSites = data.sites.filter((s) => !coveredSiteIds.has(s.id));
  const gap = useMemo(() => warrantyGapEquipment(data.assets, data.equipment, data.contract.end_date), [data.assets, data.equipment, data.contract.end_date]);
  const importable = data.terms.coverage.service_types.filter((t) => !data.services.some((s) => s.service_type.trim().toLowerCase() === t.trim().toLowerCase()));
  const noCustomer = !data.contract.customer_id;

  const assetLabel = (a: AssetRow): string => {
    if (a.equipment_id) {
      const e = equipmentById.get(a.equipment_id);
      return e ? equipmentLabel(e) : 'Equipment (removed)';
    }
    const s = a.site_id ? siteById.get(a.site_id) : undefined;
    return s ? siteLabel(s) : 'Property (removed)';
  };

  const submitAsset = async (e: React.FormEvent) => {
    e.preventDefault();
    const f = assetForm.form;
    const id = f.target === 'site' ? f.site_id : f.equipment_id;
    if (!assetForm.editingId && !id) return setFormError(f.target === 'site' ? 'Choose a property.' : 'Choose a piece of equipment.');
    setFormError(null);
    const ok = await run(
      () =>
        assetForm.editingId
          ? updateAgreementRow('agreement_assets', assetForm.editingId, { coverage_level: f.coverage_level, notes: f.notes.trim() || null })
          : insertAgreementRow('agreement_assets', ownerId, {
              contract_id: data.contract.id,
              site_id: f.target === 'site' ? f.site_id : null,
              equipment_id: f.target === 'equipment' ? f.equipment_id : null,
              coverage_level: f.coverage_level,
              notes: f.notes.trim() || null,
            }),
      assetForm.editingId ? 'Coverage updated.' : 'Added to the agreement.'
    );
    if (ok) assetForm.close();
  };

  const coverAllEquipment = () =>
    run(
      () => insertAgreementRows('agreement_assets', ownerId, uncoveredEquipment.map((e) => ({ contract_id: data.contract.id, equipment_id: e.id, coverage_level: 'full' }))),
      `${uncoveredEquipment.length} unit${uncoveredEquipment.length === 1 ? '' : 's'} added at full coverage.`
    );

  const submitService = async (e: React.FormEvent) => {
    e.preventDefault();
    const f = serviceForm.form;
    const discount = f.discount.trim() === '' ? 0 : Number(f.discount);
    const cap = dollarsToCents(f.cap);
    if (!f.service_type.trim()) return setFormError('Enter the service type.');
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) return setFormError('Discount must be between 0 and 100%.');
    if (cap === null) return setFormError('Enter the per-visit cap as a positive dollar amount.');
    setFormError(null);
    const payload = {
      service_type: f.service_type.trim(),
      coverage: f.coverage,
      labor_covered: f.coverage === 'excluded' ? false : f.labor_covered,
      parts_covered: f.coverage === 'excluded' ? false : f.parts_covered,
      discount_percent: f.coverage === 'discounted' ? discount : 0,
      per_visit_cap_cents: cap ?? null,
      notes: f.notes.trim() || null,
    };
    const ok = await run(
      () => (serviceForm.editingId ? updateAgreementRow('agreement_services', serviceForm.editingId, payload) : insertAgreementRow('agreement_services', ownerId, { ...payload, contract_id: data.contract.id })),
      serviceForm.editingId ? 'Service updated.' : 'Service added.'
    );
    if (ok) serviceForm.close();
  };

  const importFromTerms = () =>
    run(
      () =>
        insertAgreementRows(
          'agreement_services',
          ownerId,
          importable.map((t) => ({
            contract_id: data.contract.id,
            service_type: t,
            coverage: 'included',
            labor_covered: data.terms.responsibility.labor !== 'customer',
            parts_covered: data.terms.responsibility.parts === 'contractor' || data.terms.responsibility.parts === 'shared',
            per_visit_cap_cents: data.terms.responsibility.per_visit_cap_cents,
          }))
        ),
      `${importable.length} service type${importable.length === 1 ? '' : 's'} imported from the contract terms.`
    );

  const t = data.terms;

  return (
    <>
      <Panel
        title="Covered properties & equipment"
        description="Exactly which locations and units this agreement protects, and how much of each is covered."
        action={
          canManage && !noCustomer ? (
            <div className="flex flex-wrap gap-2">
              {uncoveredEquipment.length > 1 && (
                <Button size="sm" variant="secondary" onClick={coverAllEquipment} disabled={busy}>
                  Cover all {uncoveredEquipment.length} units
                </Button>
              )}
              <Button size="sm" onClick={() => assetForm.start()} disabled={assetForm.open}>
                <Plus size={14} aria-hidden="true" /> Add
              </Button>
            </div>
          ) : undefined
        }
      >
        {noCustomer && (
          <p className="mb-3 rounded-lg border border-warning-500/30 bg-warning-500/10 p-3 text-sm text-warning-500">Link this agreement to a customer (Edit agreement header) before adding covered properties or equipment.</p>
        )}

        {assetForm.open && (
          <form onSubmit={submitAsset} className="mb-4 grid gap-3 rounded-lg border border-border bg-bg-primary p-4 sm:grid-cols-2">
            {!assetForm.editingId && (
              <>
                <SelectField
                  label="Cover a"
                  value={assetForm.form.target}
                  onChange={(v) => assetForm.patch({ target: v })}
                  options={[
                    { value: 'equipment', label: 'Piece of equipment' },
                    { value: 'site', label: 'Whole property' },
                  ]}
                />
                {assetForm.form.target === 'equipment' ? (
                  <SelectField
                    label="Equipment"
                    value={assetForm.form.equipment_id}
                    onChange={(v) => assetForm.patch({ equipment_id: v })}
                    options={[{ value: '', label: uncoveredEquipment.length ? 'Select equipment…' : 'All equipment already covered' }, ...uncoveredEquipment.map((e) => ({ value: e.id, label: equipmentLabel(e) }))]}
                  />
                ) : (
                  <SelectField
                    label="Property"
                    value={assetForm.form.site_id}
                    onChange={(v) => assetForm.patch({ site_id: v })}
                    options={[{ value: '', label: uncoveredSites.length ? 'Select a property…' : 'All properties already covered' }, ...uncoveredSites.map((s) => ({ value: s.id, label: siteLabel(s) }))]}
                  />
                )}
              </>
            )}
            <SelectField label="Coverage level" value={assetForm.form.coverage_level} onChange={(v) => assetForm.patch({ coverage_level: v })} options={COVERAGE_LEVEL_OPTIONS.map((c) => ({ value: c, label: COVERAGE_LEVEL_LABELS[c] }))} />
            <div className="sm:col-span-2">
              <Textarea label="Notes" rows={2} maxLength={2000} value={assetForm.form.notes} onChange={(e) => assetForm.patch({ notes: e.target.value })} />
            </div>
            {formError && <p className="text-sm text-danger sm:col-span-2" role="alert">{formError}</p>}
            <div className="sm:col-span-2">
              <FormActions busy={busy} onCancel={() => { setFormError(null); assetForm.close(); }} submitLabel={assetForm.editingId ? 'Save changes' : 'Add to agreement'} />
            </div>
          </form>
        )}

        {data.assets.length === 0 ? (
          <EmptyState icon={Building2} title="No covered assets yet" description="Add the properties and equipment this agreement covers so coverage, maintenance and margin are exact." />
        ) : (
          <ul className="divide-y divide-border">
            {data.assets.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2.5">
                {a.equipment_id ? <Cog size={16} className="shrink-0 text-text-secondary" aria-hidden="true" /> : <Building2 size={16} className="shrink-0 text-text-secondary" aria-hidden="true" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text-primary">{assetLabel(a)}</p>
                  {a.notes && <p className="truncate text-xs text-text-secondary">{a.notes}</p>}
                </div>
                <Pill className={COVERAGE_LEVEL_STYLES[a.coverage_level]}>{COVERAGE_LEVEL_LABELS[a.coverage_level]}</Pill>
                {canManage && (
                  <RowActions
                    label={assetLabel(a)}
                    onEdit={() => assetForm.start({ ...EMPTY_ASSET, target: a.equipment_id ? 'equipment' : 'site', coverage_level: a.coverage_level, notes: a.notes ?? '' }, a.id)}
                    onDelete={() => setDeletingAsset({ id: a.id, label: assetLabel(a) })}
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        {gap.length > 0 && (
          <div className="mt-4 rounded-lg border border-warning-500/30 bg-warning-500/10 p-3">
            <p className="text-sm font-medium text-warning-500">Warranty gap: {gap.length} covered unit{gap.length === 1 ? '' : 's'} lose manufacturer warranty before this agreement ends</p>
            <p className="mt-1 text-xs text-text-secondary">After that date repair cost falls on the agreement, so price and cap it accordingly.</p>
            <ul className="mt-2 space-y-0.5 text-xs text-text-secondary">
              {gap.slice(0, 6).map((e) => (
                <li key={e.id}>
                  {equipmentLabel(e)} — {e.warranty_expires_at ? `warranty ends ${formatDate(e.warranty_expires_at)}` : 'no warranty on file'}
                </li>
              ))}
              {gap.length > 6 && <li>…and {gap.length - 6} more</li>}
            </ul>
          </div>
        )}
      </Panel>

      <Panel
        title="Covered services"
        description="Per-service rules: what is included, whether labor and parts are covered, discounts and per-visit caps."
        action={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              {importable.length > 0 && (
                <Button size="sm" variant="secondary" onClick={importFromTerms} disabled={busy}>
                  Import {importable.length} from contract terms
                </Button>
              )}
              <Button size="sm" onClick={() => serviceForm.start()} disabled={serviceForm.open}>
                <Plus size={14} aria-hidden="true" /> Add service
              </Button>
            </div>
          ) : undefined
        }
      >
        {serviceForm.open && (
          <form onSubmit={submitService} className="mb-4 grid gap-3 rounded-lg border border-border bg-bg-primary p-4 sm:grid-cols-2">
            <Input label="Service type" required maxLength={120} placeholder="e.g. Quarterly filter change" value={serviceForm.form.service_type} onChange={(e) => serviceForm.patch({ service_type: e.target.value })} />
            <SelectField label="Coverage" value={serviceForm.form.coverage} onChange={(v) => serviceForm.patch({ coverage: v })} options={SERVICE_COVERAGE_OPTIONS.map((c) => ({ value: c, label: SERVICE_COVERAGE_LABELS[c] }))} />
            {serviceForm.form.coverage !== 'excluded' && (
              <div className="flex flex-wrap items-center gap-5 sm:col-span-2">
                <CheckField label="Labor covered" checked={serviceForm.form.labor_covered} onChange={(v) => serviceForm.patch({ labor_covered: v })} />
                <CheckField label="Parts covered" checked={serviceForm.form.parts_covered} onChange={(v) => serviceForm.patch({ parts_covered: v })} />
              </div>
            )}
            {serviceForm.form.coverage === 'discounted' && <Input label="Discount (%)" type="number" inputMode="decimal" min={0} max={100} step="0.5" value={serviceForm.form.discount} onChange={(e) => serviceForm.patch({ discount: e.target.value })} />}
            {serviceForm.form.coverage !== 'excluded' && <Input label="Per-visit cap ($)" inputMode="decimal" placeholder="No cap" helperText="Covered cost above this is billed to the customer." value={serviceForm.form.cap} onChange={(e) => serviceForm.patch({ cap: e.target.value })} />}
            <div className="sm:col-span-2">
              <Textarea label="Notes" rows={2} maxLength={2000} value={serviceForm.form.notes} onChange={(e) => serviceForm.patch({ notes: e.target.value })} />
            </div>
            {formError && <p className="text-sm text-danger sm:col-span-2" role="alert">{formError}</p>}
            <div className="sm:col-span-2">
              <FormActions busy={busy} onCancel={() => { setFormError(null); serviceForm.close(); }} submitLabel={serviceForm.editingId ? 'Save changes' : 'Add service'} />
            </div>
          </form>
        )}

        {data.services.length === 0 ? (
          <EmptyState icon={ClipboardList} title="No service rules yet" description="Define which services are included, discounted or excluded. Import them straight from the verified contract terms if you have them." />
        ) : (
          <ul className="divide-y divide-border">
            {data.services.map((s: ServiceRow) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{s.service_type}</p>
                  <p className="text-xs text-text-secondary">
                    {s.coverage === 'excluded'
                      ? 'Not covered — billed at standard rates'
                      : [s.labor_covered ? 'Labor covered' : 'Labor billed', s.parts_covered ? 'Parts covered' : 'Parts billed', s.coverage === 'discounted' ? `${s.discount_percent}% discount` : null, s.per_visit_cap_cents !== null && canSeeMoney ? `cap ${formatMoney(s.per_visit_cap_cents)} / visit` : null].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <Pill className={s.coverage === 'included' ? 'bg-success-500/10 text-success-500' : s.coverage === 'discounted' ? 'bg-accent/10 text-accent' : 'bg-danger/10 text-danger'}>{SERVICE_COVERAGE_LABELS[s.coverage]}</Pill>
                {canManage && (
                  <RowActions
                    label={s.service_type}
                    onEdit={() =>
                      serviceForm.start(
                        { service_type: s.service_type, coverage: s.coverage, labor_covered: s.labor_covered, parts_covered: s.parts_covered, discount: s.discount_percent ? String(s.discount_percent) : '', cap: centsToDollarsText(s.per_visit_cap_cents), notes: s.notes ?? '' },
                        s.id
                      )
                    }
                    onDelete={() => setDeletingService({ id: s.id, label: s.service_type })}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Contract-level rules" description="Read from the structured contract terms (Contract Intelligence). Edit them there so jobs are evaluated against the same source.">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <KeyValue label="Labor" value={t.responsibility.labor === 'contractor' ? 'We cover' : t.responsibility.labor === 'customer' ? 'Customer pays' : 'Shared'} />
          <KeyValue label="Parts" value={t.responsibility.parts === 'contractor' ? 'We cover' : t.responsibility.parts === 'customer' ? 'Customer pays' : t.responsibility.parts === 'warranty_only' ? 'Manufacturer warranty only' : 'Shared'} />
          <KeyValue label="Per-visit cap" value={t.responsibility.per_visit_cap_cents === null ? 'None' : canSeeMoney ? formatMoney(t.responsibility.per_visit_cap_cents) : 'Set'} />
          <KeyValue label="After-hours" value={t.coverage.after_hours_covered ? 'Covered' : 'Not covered'} />
          <KeyValue label="Workmanship warranty" value={`${t.warranty.labor_months ?? '—'} mo labor / ${t.warranty.parts_months ?? '—'} mo parts`} />
          <KeyValue label="Exclusions" value={t.coverage.exclusions.length === 0 ? 'None listed' : `${t.coverage.exclusions.length} rule${t.coverage.exclusions.length === 1 ? '' : 's'}`} />
        </dl>
      </Panel>

      <DeleteConfirm
        target={deletingAsset}
        noun="covered asset"
        onCancel={() => setDeletingAsset(null)}
        onConfirm={async (id) => {
          await run(() => deleteAgreementRow('agreement_assets', id), 'Removed from the agreement.');
          setDeletingAsset(null);
        }}
      />
      <DeleteConfirm
        target={deletingService}
        noun="service rule"
        onCancel={() => setDeletingService(null)}
        onConfirm={async (id) => {
          await run(() => deleteAgreementRow('agreement_services', id), 'Service removed.');
          setDeletingService(null);
        }}
      />
    </>
  );
}
