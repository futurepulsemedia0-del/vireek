import { useState } from 'react';
import { Link2, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/contexts/ToastContext';

// ============================================================
// TYPES
// ============================================================

export interface EquipmentOption {
  id: string;
  label: string; // e.g. "Carrier Furnace" — same derivation as CustomerKnowledgeGraph's GraphEquipment.label
}

export interface LinkedEquipment {
  equipment_id: string;
  label: string;
  service_type: string;
}

interface JobEquipmentLinkerProps {
  jobId: string;
  userId: string;
  /** Active equipment belonging to this job's customer — the only valid choices to link. */
  equipmentOptions: EquipmentOption[];
  /** Equipment already tagged to this job. */
  linkedEquipment: LinkedEquipment[];
  onLinked: (link: LinkedEquipment) => void;
  onUnlinked: (equipmentId: string) => void;
}

const SERVICE_TYPES = [
  { value: 'repair', label: 'Repair' },
  { value: 'install', label: 'Install' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'inspection', label: 'Inspection' },
  { value: 'replacement', label: 'Replacement' },
];

// ============================================================
// COMPONENT
// ============================================================

export function JobEquipmentLinker({ jobId, userId, equipmentOptions, linkedEquipment, onLinked, onUnlinked }: JobEquipmentLinkerProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedEquipmentId, setSelectedEquipmentId] = useState('');
  const [serviceType, setServiceType] = useState('repair');

  const linkableOptions = equipmentOptions.filter(
    (opt) => !linkedEquipment.some((l) => l.equipment_id === opt.id),
  );

  const handleLink = async () => {
    if (!selectedEquipmentId) {
      toast('Pick which unit this job was for', 'error');
      return;
    }

    setSaving(true);
    const { error } = await supabase.from('job_equipment').insert({
      user_id: userId,
      job_id: jobId,
      equipment_id: selectedEquipmentId,
      service_type: serviceType,
    });
    setSaving(false);

    if (error) {
      toast('Could not link this equipment to the job', 'error');
      return;
    }

    const label = equipmentOptions.find((o) => o.id === selectedEquipmentId)?.label ?? 'Unit';
    onLinked({ equipment_id: selectedEquipmentId, label, service_type: serviceType });
    setSelectedEquipmentId('');
    setServiceType('repair');
    setOpen(false);
    toast('Equipment linked to this job', 'success');
  };

  const handleUnlink = async (equipmentId: string) => {
    const { error } = await supabase.from('job_equipment').delete().eq('job_id', jobId).eq('equipment_id', equipmentId);
    if (error) {
      toast('Could not remove this link', 'error');
      return;
    }
    onUnlinked(equipmentId);
  };

  return (
    <div className="mt-2">
      {linkedEquipment.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {linkedEquipment.map((link) => (
            <span
              key={link.equipment_id}
              className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent"
            >
              {link.label} · {link.service_type}
              <button
                type="button"
                onClick={() => handleUnlink(link.equipment_id)}
                className="focus-ring rounded-full text-accent/70 hover:text-danger"
                aria-label={`Unlink ${link.label}`}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {open ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedEquipmentId}
            onChange={(e) => setSelectedEquipmentId(e.target.value)}
            className="rounded-lg border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary focus-ring"
          >
            <option value="">Which unit?</option>
            {linkableOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>{opt.label}</option>
            ))}
          </select>
          <select
            value={serviceType}
            onChange={(e) => setServiceType(e.target.value)}
            className="rounded-lg border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary focus-ring"
          >
            {SERVICE_TYPES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleLink}
            disabled={saving || linkableOptions.length === 0}
            className="focus-ring rounded-lg bg-accent px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
          >
            {saving ? 'Linking…' : 'Link'}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="focus-ring rounded-lg px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={linkableOptions.length === 0 && linkedEquipment.length === 0}
          className="focus-ring flex items-center gap-1 text-[11px] font-medium text-text-secondary hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Link2 size={11} />
          {linkableOptions.length === 0 && linkedEquipment.length === 0 ? 'No equipment on file for this customer' : 'Link equipment'}
        </button>
      )}
    </div>
  );
}
