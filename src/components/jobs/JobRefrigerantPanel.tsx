import { useCallback, useEffect, useMemo, useState } from 'react';
import { Snowflake, AlertTriangle, ShieldCheck, ShieldAlert, Loader2, Ban } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';
import {
  addEntry,
  voidEntry,
  fetchJobLog,
  fetchEquipmentLog,
  checkTechnicianCertification,
  computeLeakRate,
  totalsFor,
  validateEntry,
  isRefrigerantJob,
  normalizeRefrigerant,
  EVENT_LABELS,
  DISPOSITION_LABELS,
  CATEGORY_LABELS,
  CERT_TYPE_LABELS,
  REFRIGERANT_CODES,
  EPA_608_CREDENTIAL_TYPES,
  certTypeFromCredential,
  LEAK_RULE_MIN_CHARGE_LBS,
  type ApplianceCategory,
  type CredentialLike,
  type Disposition,
  type RefrigerantEntry,
  type RefrigerantEventType,
} from '@/lib/refrigerantCompliance';

/** Minimal shape so both the dashboard `Job` and the technician job brief can use the panel. */
export interface RefrigerantPanelJob {
  id: string;
  service_type?: string | null;
  customer_id?: string | null;
  assigned_technician_id?: string | null;
}

interface UnitRow {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  refrigerant_type: string | null;
  refrigerant_charge_lbs: number | null;
  appliance_category: ApplianceCategory | null;
}

interface TechRow {
  id: string;
  member_name: string | null;
  member_email: string | null;
}

const inputClass =
  'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';

const unitName = (u: UnitRow) =>
  [u.make, u.model, u.equipment_type].filter(Boolean).join(' ') +
  (u.serial_number ? ` · S/N ${u.serial_number}` : '');

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function JobRefrigerantPanel({ job }: { job: RefrigerantPanelJob }) {
  const { toast } = useToast();
  const { isOwner } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [customerId, setCustomerId] = useState<string | null>(job.customer_id ?? null);
  const [assignedTech, setAssignedTech] = useState<string | null>(
    job.assigned_technician_id ?? null,
  );
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [techs, setTechs] = useState<TechRow[]>([]);
  const [creds, setCreds] = useState<CredentialLike[]>([]);
  const [jobLog, setJobLog] = useState<RefrigerantEntry[]>([]);
  const [unitLog, setUnitLog] = useState<RefrigerantEntry[]>([]);

  // form
  const [unitId, setUnitId] = useState('');
  const [techId, setTechId] = useState('');
  const [eventType, setEventType] = useState<RefrigerantEventType>('added');
  const [refrigerant, setRefrigerant] = useState('');
  const [pounds, setPounds] = useState('');
  const [cylinder, setCylinder] = useState('');
  const [disposition, setDisposition] = useState<Disposition>('returned_to_cylinder');
  const [leakFound, setLeakFound] = useState(false);
  const [leakRepaired, setLeakRepaired] = useState(false);
  const [notes, setNotes] = useState('');
  // unit profile
  const [profCharge, setProfCharge] = useState('');
  const [profCategory, setProfCategory] = useState<ApplianceCategory>('comfort_cooling');

  const relevant = isRefrigerantJob(job.service_type);

  const load = useCallback(async () => {
    try {
      let cust = job.customer_id ?? null;
      let tech = job.assigned_technician_id ?? null;
      if (cust === null || tech === null) {
        const { data } = await supabase
          .from('jobs')
          .select('customer_id, assigned_technician_id')
          .eq('id', job.id)
          .maybeSingle();
        cust = cust ?? (data?.customer_id as string | null) ?? null;
        tech = tech ?? (data?.assigned_technician_id as string | null) ?? null;
      }
      setCustomerId(cust);
      setAssignedTech(tech);

      const [log, unitsRes, techRes, credRes] = await Promise.all([
        fetchJobLog(job.id),
        cust
          ? supabase
              .from('equipment')
              .select(
                'id, equipment_type, make, model, serial_number, refrigerant_type, refrigerant_charge_lbs, appliance_category',
              )
              .eq('customer_id', cust)
              .eq('status', 'active')
          : Promise.resolve({ data: [] as UnitRow[] }),
        supabase
          .from('team_members')
          .select('id, member_name, member_email')
          .eq('role', 'technician'),
        supabase
          .from('technician_credentials')
          .select('id, technician_id, credential_type, credential_number, status, expires_at')
          .in('credential_type', EPA_608_CREDENTIAL_TYPES),
      ]);
      const unitRows = ((unitsRes.data ?? []) as UnitRow[]).map((u) => ({
        ...u,
        refrigerant_charge_lbs:
          u.refrigerant_charge_lbs === null ? null : Number(u.refrigerant_charge_lbs),
      }));
      setJobLog(log);
      setUnits(unitRows);
      setTechs((techRes.data ?? []) as TechRow[]);
      setCreds((credRes.data ?? []) as CredentialLike[]);
      setUnitLog(await fetchEquipmentLog(unitRows.map((u) => u.id)));
      setUnitId((cur) => cur || (unitRows.length === 1 ? unitRows[0].id : ''));
      setTechId((cur) => cur || tech || '');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load refrigerant records.', 'error');
    } finally {
      setLoading(false);
    }
  }, [job.id, job.customer_id, job.assigned_technician_id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const unit = units.find((u) => u.id === unitId) ?? null;

  // Pre-fill refrigerant type from the unit's profile when the unit changes.
  useEffect(() => {
    if (unit?.refrigerant_type) setRefrigerant(unit.refrigerant_type);
    setProfCharge(unit?.refrigerant_charge_lbs ? String(unit.refrigerant_charge_lbs) : '');
    setProfCategory(unit?.appliance_category ?? 'comfort_cooling');
  }, [unit?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const cert = useMemo(
    () =>
      checkTechnicianCertification(creds, techId || null, {
        chargeLbs: unit?.refrigerant_charge_lbs ?? null,
      }),
    [creds, techId, unit?.refrigerant_charge_lbs],
  );

  const leak = useMemo(
    () =>
      unit
        ? computeLeakRate({
            entries: unitLog.filter((e) => e.equipment_id === unit.id),
            fullChargeLbs: unit.refrigerant_charge_lbs,
            category: unit.appliance_category,
          })
        : null,
    [unit, unitLog],
  );

  const totals = useMemo(() => totalsFor(jobLog), [jobLog]);

  if (loading) return null;
  if (!relevant && jobLog.length === 0) return null;

  const poundsNum = Number(pounds);
  const draft = {
    job_id: job.id,
    equipment_id: unitId,
    technician_id: techId,
    event_type: eventType,
    refrigerant_type: refrigerant,
    pounds: pounds.trim() === '' ? NaN : poundsNum,
    disposition: eventType === 'recovered' ? disposition : null,
    leak_found: leakFound,
    leak_repaired: leakFound ? leakRepaired : null,
  };
  const formErrors = validateEntry(draft);
  const canSubmit = formErrors.length === 0 && cert.ok && !saving;

  const handleSubmit = async () => {
    setSaving(true);
    try {
      await addEntry({ ...draft, cylinder_ref: cylinder, notes, equipment_id: unitId });
      toast('Refrigerant entry logged.', 'success');
      setPounds('');
      setCylinder('');
      setNotes('');
      setLeakFound(false);
      setLeakRepaired(false);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the entry.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!unit) return;
    const charge = Number(profCharge);
    if (!Number.isFinite(charge) || charge <= 0) {
      toast('Enter the unit’s full refrigerant charge in pounds.', 'error');
      return;
    }
    const { error } = await supabase
      .from('equipment')
      .update({
        refrigerant_type: refrigerant ? normalizeRefrigerant(refrigerant) : unit.refrigerant_type,
        refrigerant_charge_lbs: charge,
        appliance_category: profCategory,
      })
      .eq('id', unit.id);
    if (error) toast(error.message, 'error');
    else {
      toast('Unit profile saved.', 'success');
      await load();
    }
  };

  const handleVoid = async (entry: RefrigerantEntry) => {
    const reason = window.prompt(
      'Why is this entry being voided? (min. 5 characters — kept in the audit record)',
    );
    if (!reason) return;
    try {
      await voidEntry(entry.id, reason);
      toast('Entry voided. It stays in the ledger, marked as voided.', 'success');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not void the entry.', 'error');
    }
  };

  const techName = (id: string) => {
    const t = techs.find((x) => x.id === id);
    return t?.member_name || t?.member_email || 'Technician';
  };

  return (
    <section
      className="rounded-xl border border-border bg-bg-secondary p-4"
      aria-label="Refrigerant log"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="focus-ring flex w-full items-center gap-3 rounded-lg text-left"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Snowflake size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-text-primary">Refrigerant log</span>
          <span className="block text-xs text-text-secondary">
            {jobLog.length === 0
              ? 'Log refrigerant added or recovered on this job'
              : `${totals.added} lb added · ${totals.recovered} lb recovered`}
          </span>
        </span>
        {leak?.exceeds && (
          <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">
            Leak rate over limit
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">
          {!customerId || units.length === 0 ? (
            <p className="rounded-lg bg-bg-tertiary p-3 text-sm text-text-secondary">
              This job’s customer has no active equipment on file. Add the unit under the customer’s
              Equipment first — refrigerant is logged per unit.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-text-secondary">
                Unit
                <select
                  className={inputClass}
                  value={unitId}
                  onChange={(e) => setUnitId(e.target.value)}
                >
                  <option value="">Select unit…</option>
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {unitName(u)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-text-secondary">
                Technician
                <select
                  className={inputClass}
                  value={techId}
                  onChange={(e) => setTechId(e.target.value)}
                >
                  <option value="">Select technician…</option>
                  {techs.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.member_name || t.member_email}
                      {t.id === assignedTech ? ' (assigned)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {unit && (
            <>
              {/* Certification check */}
              <div
                role="status"
                className={`flex items-start gap-2 rounded-lg p-3 text-xs ${cert.ok ? 'bg-success-500/10 text-success-500' : 'bg-danger/10 text-danger'}`}
              >
                {cert.ok ? (
                  <ShieldCheck size={16} className="mt-0.5 shrink-0" />
                ) : (
                  <ShieldAlert size={16} className="mt-0.5 shrink-0" />
                )}
                <div>
                  {cert.ok ? (
                    <p className="font-medium">
                      EPA 608 certified —{' '}
                      {
                        CERT_TYPE_LABELS[
                          cert.certType ??
                            certTypeFromCredential(cert.credential?.credential_type ?? '') ??
                            'unspecified'
                        ]
                      }
                      {cert.credential?.credential_number
                        ? ` · #${cert.credential.credential_number}`
                        : ''}
                    </p>
                  ) : (
                    <p className="font-medium">{cert.reason}</p>
                  )}
                  {cert.warnings.map((w) => (
                    <p key={w} className="mt-0.5 text-warning-500">
                      {w}
                    </p>
                  ))}
                </div>
              </div>

              {/* Unit profile (needed for leak-rate math) */}
              {(!unit.refrigerant_charge_lbs || !unit.appliance_category) && (
                <div className="rounded-lg border border-border/70 bg-bg-primary p-3">
                  <p className="mb-2 text-xs font-medium text-text-primary">
                    Set this unit’s full charge to enable leak-rate tracking
                  </p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <input
                      className={inputClass}
                      inputMode="decimal"
                      placeholder="Full charge (lb)"
                      value={profCharge}
                      onChange={(e) => setProfCharge(e.target.value)}
                      aria-label="Full charge in pounds"
                    />
                    <select
                      className={inputClass}
                      value={profCategory}
                      onChange={(e) => setProfCategory(e.target.value as ApplianceCategory)}
                      aria-label="Appliance category"
                    >
                      {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleSaveProfile}
                      className="focus-ring rounded-lg border border-accent px-3 py-2 text-sm font-medium text-accent"
                    >
                      Save unit profile
                    </button>
                  </div>
                </div>
              )}

              {/* Leak rate */}
              {leak && leak.fullChargeLbs !== null && (
                <div
                  className={`rounded-lg p-3 text-xs ${leak.exceeds ? 'bg-danger/10 text-danger' : 'bg-bg-tertiary text-text-secondary'}`}
                >
                  <p className="flex items-center gap-1.5 font-medium">
                    {leak.exceeds && <AlertTriangle size={14} />}
                    Leak rate:{' '}
                    {leak.ratePct === null
                      ? 'not enough history yet'
                      : `${leak.ratePct}% (limit ${leak.threshold}%)`}
                  </p>
                  <p className="mt-0.5">
                    {leak.poundsAdded365} lb added in the last 12 months on a {leak.fullChargeLbs}{' '}
                    lb charge
                    {!leak.covered &&
                      ` — below the ${LEAK_RULE_MIN_CHARGE_LBS} lb coverage threshold, tracked for your records`}
                    .
                  </p>
                  {leak.exceeds && leak.repairDeadline && (
                    <p className="mt-0.5 font-medium">
                      Repair due by {new Date(leak.repairDeadline).toLocaleDateString()}.
                    </p>
                  )}
                </div>
              )}

              {/* Entry form */}
              <div className="space-y-3 rounded-lg border border-border/70 bg-bg-primary p-3">
                <div className="grid grid-cols-2 gap-2" role="group" aria-label="Event type">
                  {(['added', 'recovered'] as RefrigerantEventType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={eventType === t}
                      onClick={() => setEventType(t)}
                      className={`focus-ring rounded-lg px-3 py-2 text-sm font-medium ${eventType === t ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary'}`}
                    >
                      {EVENT_LABELS[t]}
                    </button>
                  ))}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs text-text-secondary">
                    Refrigerant
                    <input
                      className={inputClass}
                      list="refrigerant-codes"
                      value={refrigerant}
                      onChange={(e) => setRefrigerant(e.target.value)}
                      placeholder="R-410A"
                    />
                    <datalist id="refrigerant-codes">
                      {REFRIGERANT_CODES.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                  </label>
                  <label className="text-xs text-text-secondary">
                    Pounds
                    <input
                      className={inputClass}
                      inputMode="decimal"
                      value={pounds}
                      onChange={(e) => setPounds(e.target.value)}
                      placeholder="0.00"
                    />
                  </label>
                  <label className="text-xs text-text-secondary">
                    Cylinder / tag # (optional)
                    <input
                      className={inputClass}
                      value={cylinder}
                      onChange={(e) => setCylinder(e.target.value)}
                      maxLength={80}
                    />
                  </label>
                  {eventType === 'recovered' && (
                    <label className="text-xs text-text-secondary">
                      Where did it go?
                      <select
                        className={inputClass}
                        value={disposition}
                        onChange={(e) => setDisposition(e.target.value as Disposition)}
                      >
                        {Object.entries(DISPOSITION_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <div className="flex flex-wrap gap-4 text-xs text-text-secondary">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={leakFound}
                      onChange={(e) => setLeakFound(e.target.checked)}
                    />{' '}
                    Leak found
                  </label>
                  {leakFound && (
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={leakRepaired}
                        onChange={(e) => setLeakRepaired(e.target.checked)}
                      />{' '}
                      Leak repaired
                    </label>
                  )}
                </div>
                <textarea
                  className={inputClass}
                  rows={2}
                  maxLength={2000}
                  placeholder="Notes (optional)"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
                {formErrors.length > 0 && (pounds !== '' || refrigerant !== '') && (
                  <p className="text-xs text-warning-500">{formErrors[0]}</p>
                )}
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className="focus-ring flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {saving && <Loader2 size={14} className="animate-spin" />} Log entry
                </button>
              </div>
            </>
          )}

          {/* Job ledger */}
          {jobLog.length > 0 && (
            <ul className="space-y-2">
              {jobLog.map((e) => (
                <li
                  key={e.id}
                  className={`rounded-lg border border-border/70 bg-bg-primary p-3 text-xs ${e.voided_at ? 'opacity-60' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p
                      className={`font-medium text-text-primary ${e.voided_at ? 'line-through' : ''}`}
                    >
                      {EVENT_LABELS[e.event_type]} {e.pounds.toFixed(2)} lb {e.refrigerant_type}
                    </p>
                    {!e.voided_at && isOwner && (
                      <button
                        type="button"
                        onClick={() => handleVoid(e)}
                        className="focus-ring inline-flex items-center gap-1 rounded text-text-secondary hover:text-danger"
                        aria-label="Void entry"
                      >
                        <Ban size={12} /> Void
                      </button>
                    )}
                  </div>
                  <p className="mt-0.5 text-text-secondary">
                    {e.equipment_label || 'Unit'} ·{' '}
                    {e.technician_name ||
                      (e.technician_id ? techName(e.technician_id) : 'Technician')}{' '}
                    · {fmtDate(e.performed_at)}
                  </p>
                  <p className="text-text-secondary">
                    {CERT_TYPE_LABELS[certTypeFromCredential(e.cert_type) ?? 'unspecified']}
                    {e.cert_number ? ` #${e.cert_number}` : ''}
                    {e.disposition ? ` · ${DISPOSITION_LABELS[e.disposition]}` : ''}
                    {e.leak_found ? ` · leak found${e.leak_repaired ? ', repaired' : ''}` : ''}
                  </p>
                  {e.voided_at && <p className="mt-1 text-danger">Voided: {e.void_reason}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
