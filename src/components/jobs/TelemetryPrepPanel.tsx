import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Cpu, PackageCheck, PackageX } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/contexts/ToastContext';
import type { Job } from '@/lib/supabase';
import { SEVERITY_STYLES, metricLabel, recordOutcome, riskTone, type FailurePrediction } from '@/lib/telemetry';

/**
 * Technician preparation: shows what the machine itself has been telling us
 * about the equipment on this job — likely failure, evidence, parts to bring —
 * and captures the outcome so the model learns from every visit.
 * Renders nothing when there is no telemetry-based prediction for the job.
 */
export function TelemetryPrepPanel({ job }: { job: Job }) {
  const { toast } = useToast();
  const [items, setItems] = useState<FailurePrediction[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: links } = await supabase.from('job_equipment').select('equipment_id').eq('job_id', job.id);
    const equipmentIds = (links ?? []).map((l) => l.equipment_id as string);
    if (equipmentIds.length === 0) { setItems([]); return; }
    const { data } = await supabase
      .from('equipment_failure_predictions')
      .select('id, equipment_id, failure_mode, failure_label, probability, confidence, horizon_days, drivers, predicted_parts, recommended_action, status, job_id, created_at, equipment:equipment_id (equipment_type, make, model, customer_id)')
      .in('equipment_id', equipmentIds)
      .in('status', ['open', 'prepared'])
      .order('probability', { ascending: false });
    setItems((data ?? []) as unknown as FailurePrediction[]);
  }, [job.id]);

  useEffect(() => { void load(); }, [load]);

  const answer = async (p: FailurePrediction, outcome: 'confirmed' | 'false_alarm') => {
    setBusyId(p.id);
    try {
      await recordOutcome(p, outcome);
      toast(outcome === 'confirmed' ? 'Thanks — prediction confirmed and learned.' : 'Thanks — marked as false alarm and learned.', 'success');
      await load();
    } catch {
      toast('Could not save feedback', 'error');
    } finally { setBusyId(null); }
  };

  if (items.length === 0) return null;

  return (
    <div className="mt-4 rounded-2xl border border-accent/30 bg-accent/5 p-4">
      <div className="mb-2 flex items-center gap-2">
        <Cpu size={16} className="text-accent" />
        <h3 className="text-sm font-semibold text-text-primary">Telemetry brief</h3>
        <Link to="/dashboard/building-telemetry" className="ml-auto text-xs font-medium text-accent hover:underline">Open Building Telemetry →</Link>
      </div>
      <div className="space-y-3">
        {items.map((p) => {
          const pct = Math.round(p.probability * 100);
          return (
            <div key={p.id} className="rounded-xl border border-border bg-bg-secondary p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${SEVERITY_STYLES[riskTone(p.probability)]}`}>{pct}%</span>
                <span className="text-sm font-medium text-text-primary">{p.failure_label}</span>
              </div>
              {p.drivers.length > 0 && (
                <p className="mt-1 text-xs text-text-secondary">
                  Evidence: {p.drivers.map((d) => `${metricLabel(d.metric)} ${d.direction === 'high' ? '↑' : '↓'}`).join(', ')}
                </p>
              )}
              {p.recommended_action && <p className="mt-1 text-xs font-medium text-accent">{p.recommended_action}</p>}
              {p.predicted_parts.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {p.predicted_parts.map((part) => {
                    const ok = part.part_id !== null && part.in_stock !== null && part.in_stock >= part.qty;
                    return (
                      <li key={part.label} className="flex items-center gap-1.5 text-xs text-text-secondary">
                        {ok ? <PackageCheck size={12} className="text-success-500" /> : <PackageX size={12} className="text-warning-500" />}
                        {part.qty}× {part.part_name ?? part.label}
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="mt-3 flex gap-2">
                <button type="button" disabled={busyId === p.id} onClick={() => answer(p, 'confirmed')}
                  className="focus-ring rounded-lg border border-border px-3 py-1 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50">
                  Failure confirmed
                </button>
                <button type="button" disabled={busyId === p.id} onClick={() => answer(p, 'false_alarm')}
                  className="focus-ring rounded-lg border border-border px-3 py-1 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50">
                  No fault found
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
