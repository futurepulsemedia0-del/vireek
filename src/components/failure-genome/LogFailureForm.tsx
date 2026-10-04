import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import {
  COMPONENT_SUGGESTIONS,
  OUTCOME_META,
  REPAIR_SUGGESTIONS,
  SELECT_CLASS,
  fetchLatestDiagnosis,
  logFailureEvent,
  parseTags,
  prefillFromDiagnosis,
  slugify,
  unitLabel,
  type FailureOutcome,
  type UnitRow,
} from '@/lib/failureGenome';

const today = () => new Date().toISOString().slice(0, 10);

export function LogFailureForm({
  units,
  initialEquipmentId = '',
  onLogged,
}: {
  units: UnitRow[];
  initialEquipmentId?: string;
  onLogged: (equipmentId: string) => void;
}) {
  const { toast } = useToast();
  const [equipmentId, setEquipmentId] = useState(initialEquipmentId);
  const [occurredOn, setOccurredOn] = useState(today());
  const [symptoms, setSymptoms] = useState('');
  const [component, setComponent] = useState('');
  const [mode, setMode] = useState('');
  const [repairAction, setRepairAction] = useState('');
  const [parts, setParts] = useState('');
  const [outcome, setOutcome] = useState<FailureOutcome>('fixed');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');
  const [source, setSource] = useState<'manual' | 'diagnosis'>('manual');
  const [saving, setSaving] = useState(false);

  const onPrefill = async () => {
    if (!equipmentId) {
      toast('Pick a unit first.', 'error');
      return;
    }
    const d = await fetchLatestDiagnosis(equipmentId).catch(() => null);
    if (!d) {
      toast('No AI diagnosis is linked to this unit yet.', 'info');
      return;
    }
    const pre = prefillFromDiagnosis(d);
    setComponent(pre.component);
    setParts(pre.parts);
    setNotes(pre.notes);
    setSource('diagnosis');
    toast('Prefilled from the latest AI diagnosis - review before saving.', 'info');
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const slug = slugify(component);
    if (!equipmentId) return toast('Pick the unit that failed.', 'error');
    if (!slug) return toast('Enter the failed component using letters or numbers (e.g. run capacitor).', 'error');
    const costValue = cost.trim() === '' ? null : Number(cost);
    if (costValue != null && (!Number.isFinite(costValue) || costValue < 0)) return toast('Repair cost must be a positive number.', 'error');

    setSaving(true);
    try {
      await logFailureEvent({
        equipmentId,
        occurredOn,
        symptoms: parseTags(symptoms),
        component: slug,
        mode,
        repairAction,
        parts: parseTags(parts),
        outcome,
        repairCost: costValue,
        notes,
        source,
      });
      toast('Failure logged - the unit genome has been updated.', 'success');
      setSymptoms(''); setComponent(''); setMode(''); setRepairAction(''); setParts(''); setCost(''); setNotes('');
      setSource('manual');
      onLogged(equipmentId);
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : 'Could not save this failure. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="fg-unit" className="mb-1.5 block text-sm font-medium text-text-primary">Unit that failed</label>
          <select id="fg-unit" value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)} className={SELECT_CLASS} required>
            <option value="">Select a unit…</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>{unitLabel(u)}</option>
            ))}
          </select>
        </div>
        <Input label="Date of failure" type="date" value={occurredOn} max={today()} onChange={(e) => setOccurredOn(e.target.value)} required />
      </div>

      <Input
        label="Symptoms"
        value={symptoms}
        onChange={(e) => setSymptoms(e.target.value)}
        helperText="Comma-separated, e.g. hard start, tripping breaker, low airflow"
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Failed component" list="fg-components" value={component} onChange={(e) => setComponent(e.target.value)} required />
        <Input label="Failure mode (optional)" value={mode} onChange={(e) => setMode(e.target.value)} helperText="e.g. worn, shorted, seized, leaking" />
        <Input label="Repair action" list="fg-repairs" value={repairAction} onChange={(e) => setRepairAction(e.target.value)} />
        <Input label="Parts replaced" value={parts} onChange={(e) => setParts(e.target.value)} helperText="Comma-separated" />
      </div>
      <datalist id="fg-components">{COMPONENT_SUGGESTIONS.map((c) => <option key={c} value={c.replace(/_/g, ' ')} />)}</datalist>
      <datalist id="fg-repairs">{REPAIR_SUGGESTIONS.map((c) => <option key={c} value={c.replace(/_/g, ' ')} />)}</datalist>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="fg-outcome" className="mb-1.5 block text-sm font-medium text-text-primary">Outcome</label>
          <select id="fg-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as FailureOutcome)} className={SELECT_CLASS}>
            {(Object.keys(OUTCOME_META) as FailureOutcome[]).map((o) => (
              <option key={o} value={o}>{OUTCOME_META[o].label}</option>
            ))}
          </select>
        </div>
        <Input label="Repair cost (optional)" type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
      </div>

      <Textarea label="Notes (optional, never shared)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Log failure'}</Button>
        <Button type="button" variant="secondary" onClick={onPrefill}>Prefill from latest AI diagnosis</Button>
      </div>
    </form>
  );
}
