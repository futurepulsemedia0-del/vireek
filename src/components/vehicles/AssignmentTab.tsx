import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { assignVehicle, fetchAssignments } from '@/lib/vehicleManagementApi';
import type { Technician, Vehicle } from '@/lib/vehicleManagement';
import { ErrorState, Pill, Section, SelectField, formatDateTime, useLoader } from './shared';

interface Props {
  vehicle: Vehicle;
  technicians: Technician[];
  onChanged: () => void;
}

const techName = (t: Technician) => t.member_name?.trim() || t.member_email;

export function AssignmentTab({ vehicle, technicians, onChanged }: Props) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const history = useLoader(() => fetchAssignments(vehicle.id), vehicle.id);
  const [techId, setTechId] = useState(vehicle.assigned_technician_id ?? '');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Active technicians, plus the current assignee even if they are no longer active.
  const options = useMemo(
    () => technicians.filter((t) => t.invite_status === 'active' || t.id === vehicle.assigned_technician_id),
    [technicians, vehicle.assigned_technician_id],
  );
  const current = technicians.find((t) => t.id === vehicle.assigned_technician_id);
  const retired = vehicle.status === 'retired';
  const unchanged = (techId || null) === vehicle.assigned_technician_id;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (unchanged || saving) return;
    setSaving(true);
    try {
      await assignVehicle(vehicle.id, techId || null, notes.trim() || null);
      toast(techId ? 'Vehicle assigned.' : 'Vehicle unassigned.', 'success');
      setNotes('');
      onChanged();
      void history.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change the assignment.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Section title="Current driver">
        {options.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No technicians to assign"
            description="Invite a technician to your team first, then assign them a vehicle here."
            action={{ label: 'Go to Team', onClick: () => navigate('/dashboard/team') }}
          />
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <p className="text-sm text-text-secondary">
              {vehicle.assigned_technician_id
                ? <>Currently assigned to <span className="font-medium text-text-primary">{current ? techName(current) : 'a technician'}</span>.</>
                : 'This vehicle is not assigned to anyone.'}
            </p>
            {retired && <p role="status" className="text-sm text-warning-500">Retired vehicles cannot be assigned. Change the status to assign it again.</p>}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SelectField label="Technician" value={techId} onChange={(e) => setTechId(e.target.value)} disabled={retired || saving}>
                <option value="">Unassigned</option>
                {options.map((t) => <option key={t.id} value={t.id}>{techName(t)}{t.invite_status !== 'active' ? ' (inactive)' : ''}</option>)}
              </SelectField>
              <Input label="Note (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="e.g. Seasonal route change" disabled={retired || saving} />
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={retired || unchanged || saving}>{saving ? 'Saving…' : techId ? 'Assign vehicle' : 'Unassign vehicle'}</Button>
            </div>
          </form>
        )}
      </Section>

      <Section title="Assignment history">
        {history.loading && !history.data ? (
          <SkeletonCardList count={2} rows={1} />
        ) : history.error && !history.data ? (
          <ErrorState message={history.error} onRetry={history.reload} />
        ) : (history.data ?? []).length === 0 ? (
          <EmptyState icon={Users} title="No assignment history" description="Every assignment you make from this page is recorded here." />
        ) : (
          <ul className="divide-y divide-border">
            {(history.data ?? []).map((a) => (
              <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary">{a.technician_name}</p>
                  <p className="text-xs text-text-secondary">{formatDateTime(a.assigned_at)} → {a.unassigned_at ? formatDateTime(a.unassigned_at) : 'now'}</p>
                  {a.notes && <p className="mt-1 text-xs text-text-secondary">{a.notes}</p>}
                </div>
                {!a.unassigned_at && <Pill tone="success">Current</Pill>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
