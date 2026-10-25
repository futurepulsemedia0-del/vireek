import { useMemo, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { formatMoney } from '@/lib/currency';
import { reviewAnomalies, type FuelVehicle } from '@/lib/fuelCardsApi';
import {
  ANOMALY_META, describeAnomaly, formatGallons, humanize, sortAnomalies,
  type AnomalySeverity, type AnomalyStatus, type FuelAnomaly,
} from '@/lib/fuelCards';
import { Pill, SelectField, formatDateTime, type Tone } from '@/components/vehicles/shared';

const SEVERITY_TONE: Record<AnomalySeverity, Tone> = { critical: 'danger', warning: 'warning', info: 'info' };
const STATUS_TONE: Record<AnomalyStatus, Tone> = { open: 'warning', confirmed: 'danger', dismissed: 'neutral' };

interface Props {
  anomalies: FuelAnomaly[];
  vehicles: FuelVehicle[];
  onChanged: () => Promise<unknown> | void;
}

export function FuelAnomaliesTab({ anomalies, vehicles, onChanged }: Props) {
  const { toast } = useToast();
  const { currency } = useCurrency();
  const money = (n: number) => formatMoney(n, currency);
  const [status, setStatus] = useState<AnomalyStatus | 'all'>('open');
  const [severity, setSeverity] = useState<AnomalySeverity | 'all'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<{ id: string; status: AnomalyStatus } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const vehicleNames = useMemo(() => new Map(vehicles.map((v) => [v.id, v.label])), [vehicles]);
  const visible = useMemo(
    () => sortAnomalies(anomalies).filter((a) => (status === 'all' || a.status === status) && (severity === 'all' || a.severity === severity)),
    [anomalies, status, severity],
  );

  const run = async (ids: string[], next: AnomalyStatus, text: string | null) => {
    if (busy || ids.length === 0) return;
    setBusy(true);
    try {
      await reviewAnomalies(ids, next, text);
      toast(ids.length === 1 ? 'Anomaly updated.' : `${ids.length} anomalies updated.`, 'success');
      setSelected(new Set()); setPending(null); setNote('');
      await onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the anomalies.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSelected = visible.length > 0 && visible.every((a) => selected.has(a.id));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SelectField label="Status" value={status} onChange={(e) => { setStatus(e.target.value as AnomalyStatus | 'all'); setSelected(new Set()); }}>
          <option value="open">Open</option>
          <option value="confirmed">Confirmed</option>
          <option value="dismissed">Dismissed</option>
          <option value="all">All</option>
        </SelectField>
        <SelectField label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value as AnomalySeverity | 'all')}>
          <option value="all">All severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </SelectField>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title={anomalies.length === 0 ? 'No anomalies yet' : 'Nothing to review'}
          description={anomalies.length === 0 ? 'Import transactions and Vireek will flag unusual purchases automatically.' : 'No anomalies match these filters.'}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex min-h-[40px] items-center gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                className="h-5 w-5 accent-accent"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(visible.map((a) => a.id)))}
              />
              Select all ({visible.length})
            </label>
            {selected.size > 0 && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run([...selected], 'dismissed', null)}>Dismiss {selected.size}</Button>
                <Button size="sm" disabled={busy} onClick={() => void run([...selected], 'confirmed', null)}>Confirm {selected.size}</Button>
              </div>
            )}
          </div>

          <ul className="space-y-2" aria-label="Fuel anomalies">
            {visible.map((a) => {
              const t = a.transaction;
              const vehicle = t?.vehicle_id ? vehicleNames.get(t.vehicle_id) : null;
              const isPending = pending?.id === a.id;
              return (
                <li key={a.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-5 w-5 shrink-0 accent-accent"
                      aria-label={`Select ${ANOMALY_META[a.rule].label}`}
                      checked={selected.has(a.id)}
                      onChange={() => toggle(a.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill tone={SEVERITY_TONE[a.severity]}>{humanize(a.severity)}</Pill>
                        <span className="text-sm font-semibold text-text-primary">{ANOMALY_META[a.rule].label}</span>
                        {a.status !== 'open' && <Pill tone={STATUS_TONE[a.status]}>{humanize(a.status)}</Pill>}
                      </div>
                      <p className="mt-1 text-sm text-text-primary">{describeAnomaly(a, money)}</p>
                      {t && (
                        <p className="mt-1 break-words text-xs text-text-secondary">
                          {[formatDateTime(t.transaction_at), t.merchant, money(t.amount), t.gallons > 0 ? formatGallons(t.gallons) : null, vehicle, t.technician_name]
                            .filter(Boolean).join(' · ')}
                        </p>
                      )}
                      {a.note && <p className="mt-1 text-xs italic text-text-secondary">Note: {a.note}</p>}

                      {isPending ? (
                        <div className="mt-3 space-y-2">
                          <Textarea label="Note (optional)" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" disabled={busy} onClick={() => void run([a.id], pending.status, note.trim() || null)}>
                              {pending.status === 'confirmed' ? 'Confirm issue' : 'Dismiss'}
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setPending(null); setNote(''); }}>Cancel</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {a.status === 'open' ? (
                            <>
                              <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setPending({ id: a.id, status: 'confirmed' }); setNote(''); }}>Confirm issue</Button>
                              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setPending({ id: a.id, status: 'dismissed' }); setNote(''); }}>Dismiss</Button>
                            </>
                          ) : (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run([a.id], 'open', null)}>Reopen</Button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
