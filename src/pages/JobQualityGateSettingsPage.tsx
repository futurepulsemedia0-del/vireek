import { useEffect, useMemo, useState, useCallback } from 'react';
import { ClipboardCheck, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { supabase, Job } from '@/lib/supabase';
import {
  fetchQualityRequirements,
  saveQualityRequirement,
  fetchAllChecklistTemplates,
  addChecklistTemplateItem,
  deleteChecklistTemplateItem,
  type QualityRequirement,
  type ChecklistTemplateItem,
} from '@/lib/jobQualityGate';
import { EmptyState } from '@/components/EmptyState';

const FLAGS: { key: keyof Omit<QualityRequirement, 'id' | 'service_type'>; label: string }[] = [
  { key: 'require_photos', label: 'Photos' },
  { key: 'require_checklist', label: 'Checklist' },
  { key: 'require_part_usage', label: 'Part usage' },
  { key: 'require_signature', label: 'Signature' },
  { key: 'require_serial_number', label: 'Serial number' },
  { key: 'require_notes', label: 'Notes' },
  { key: 'require_safety_evidence', label: 'Safety evidence' },
];

const DEFAULTS: Omit<QualityRequirement, 'id' | 'service_type'> = {
  require_photos: true,
  require_checklist: false,
  require_part_usage: false,
  require_signature: true,
  require_serial_number: false,
  require_notes: true,
  require_safety_evidence: false,
};

export function JobQualityGateSettingsPage() {
  const { user, isOwner } = useAuth();
  const { toast } = useToast();
  const [serviceTypes, setServiceTypes] = useState<string[]>([]);
  const [requirements, setRequirements] = useState<Record<string, QualityRequirement | undefined>>({});
  const [templates, setTemplates] = useState<ChecklistTemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newItemLabel, setNewItemLabel] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [{ data: jobs }, reqs, tpl] = await Promise.all([
        supabase.from('jobs').select('service_type').not('service_type', 'is', null),
        fetchQualityRequirements(),
        fetchAllChecklistTemplates(),
      ]);
      const types = Array.from(new Set(((jobs as Pick<Job, 'service_type'>[]) ?? []).map((j) => j.service_type as string))).sort();
      setServiceTypes(types);
      setRequirements(Object.fromEntries(reqs.map((r) => [r.service_type, r])));
      setTemplates(tpl);
    } catch {
      // empty state below
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const templatesByType = useMemo(() => {
    const map: Record<string, ChecklistTemplateItem[]> = {};
    for (const t of templates) {
      (map[t.service_type] ??= []).push(t);
    }
    return map;
  }, [templates]);

  const handleToggle = async (serviceType: string, key: keyof typeof DEFAULTS, value: boolean) => {
    if (!user) return;
    const current = requirements[serviceType] ?? { id: '', service_type: serviceType, ...DEFAULTS };
    const next = { ...current, [key]: value };
    setRequirements((prev) => ({ ...prev, [serviceType]: next }));
    try {
      const { id: _id, service_type: _st, ...flags } = next;
      await saveQualityRequirement(serviceType, flags, user.id);
    } catch {
      toast('Could not save requirement.', 'error');
      load();
    }
  };

  const handleAddItem = async (serviceType: string) => {
    if (!user) return;
    const label = (newItemLabel[serviceType] ?? '').trim();
    if (!label) return;
    const sortOrder = (templatesByType[serviceType]?.length ?? 0) + 1;
    try {
      await addChecklistTemplateItem(serviceType, label, sortOrder, user.id);
      setNewItemLabel((prev) => ({ ...prev, [serviceType]: '' }));
      load();
    } catch {
      toast('Could not add checklist item.', 'error');
    }
  };

  const handleDeleteItem = async (id: string) => {
    try {
      await deleteChecklistTemplateItem(id);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch {
      toast('Could not remove checklist item.', 'error');
    }
  };

  if (!isOwner) {
    return (
      <DashboardLayout activeLabel="Job Quality Gate">
        <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <h3 className="text-lg font-semibold text-text-primary">Owner access only</h3>
          <p className="mt-1.5 text-sm text-text-secondary">Only the account owner can configure job quality requirements.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Job Quality Gate">
      <div className="mb-8">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
          <ClipboardCheck size={22} /> Job Quality Gate
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          No Proof, No Close — choose which evidence is required before a job can be marked completed or invoiced, per service type.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading...</p>
      ) : serviceTypes.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="No service types yet" description="Requirements appear here once jobs with a service type exist." />
      ) : (
        <div className="space-y-6">
          {serviceTypes.map((st) => {
            const req = requirements[st] ?? { id: '', service_type: st, ...DEFAULTS };
            return (
              <Card key={st} className="p-5">
                <h3 className="text-sm font-semibold text-text-primary">{st}</h3>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {FLAGS.map((f) => (
                    <label key={f.key} className="flex items-center gap-2 text-xs text-text-secondary">
                      <input
                        type="checkbox"
                        checked={req[f.key]}
                        onChange={(e) => handleToggle(st, f.key, e.target.checked)}
                        className="h-3.5 w-3.5 rounded border-border"
                      />
                      {f.label}
                    </label>
                  ))}
                </div>

                {req.require_checklist && (
                  <div className="mt-4 border-t border-border/60 pt-3">
                    <p className="mb-1.5 text-xs font-medium text-text-secondary">Checklist items</p>
                    <div className="space-y-1.5">
                      {(templatesByType[st] ?? []).map((t) => (
                        <div key={t.id} className="flex items-center justify-between text-sm text-text-primary">
                          <span>{t.item_label}</span>
                          <button type="button" onClick={() => handleDeleteItem(t.id)} className="text-text-secondary hover:text-danger">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <input
                        type="text"
                        value={newItemLabel[st] ?? ''}
                        onChange={(e) => setNewItemLabel((prev) => ({ ...prev, [st]: e.target.value }))}
                        placeholder="Add checklist item..."
                        className="flex-1 rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => handleAddItem(st)}
                        className="focus-ring flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                      >
                        <Plus size={13} /> Add
                      </button>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </DashboardLayout>
  );
}
