import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, Plus, RefreshCw } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import {
  SEVERITY_LABELS,
  errorMessage,
  fetchAllChecklistItems,
  saveChecklistItem,
  slugifyKey,
  type ChecklistItem,
  type ItemSeverity,
} from '@/lib/dvir';

const MAX_ITEMS = 60;
const SELECT = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

function ItemEditor({ item, onSaved }: { item: ChecklistItem; onSaved: (next: ChecklistItem) => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState(item);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(item);

  const save = async (next: ChecklistItem) => {
    if (next.label.trim().length === 0) {
      toast('Label cannot be empty', 'error');
      return;
    }
    setSaving(true);
    try {
      await saveChecklistItem(next);
      onSaved(next);
      toast('Checklist item saved', 'success');
    } catch (e) {
      toast(errorMessage(e, 'Could not save the item'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className={`rounded-xl border border-border bg-bg-secondary p-3 ${draft.active ? '' : 'opacity-60'}`}>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input aria-label="Label" value={draft.label} maxLength={120} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        <Input aria-label="Category" value={draft.category} maxLength={40} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
        <select
          aria-label="Severity if defective"
          className={SELECT}
          value={draft.severity_if_defect}
          onChange={(e) => setDraft({ ...draft, severity_if_defect: e.target.value as ItemSeverity })}
        >
          {(Object.keys(SEVERITY_LABELS) as ItemSeverity[]).map((s) => (
            <option key={s} value={s}>
              {SEVERITY_LABELS[s]}
              {s === 'out_of_service' ? ' (blocks dispatch)' : ''}
            </option>
          ))}
        </select>
        <select
          aria-label="Applies to"
          className={SELECT}
          value={draft.applies_to}
          onChange={(e) => setDraft({ ...draft, applies_to: e.target.value as ChecklistItem['applies_to'] })}
        >
          <option value="both">Pre-trip &amp; post-trip</option>
          <option value="pre_trip">Pre-trip only</option>
          <option value="post_trip">Post-trip only</option>
        </select>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-text-primary">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.requires_photo} onChange={(e) => setDraft({ ...draft, requires_photo: e.target.checked })} />
          Photo required on defect
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
          Active
        </label>
        <Button size="sm" className="ml-auto" disabled={!dirty || saving} onClick={() => void save(draft)}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </li>
  );
}

export function DvirChecklistEditor() {
  const { toast } = useToast();
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchAllChecklistItems());
    } catch (e) {
      setError(errorMessage(e, 'Could not load the checklist'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const label = newLabel.trim();
    const key = slugifyKey(label);
    if (!key) {
      toast('Enter a label for the new item', 'error');
      return;
    }
    if (items.some((i) => i.item_key === key)) {
      toast('An item with this name already exists', 'error');
      return;
    }
    setAdding(true);
    try {
      const sortOrder = Math.max(0, ...items.map((i) => i.sort_order)) + 10;
      await saveChecklistItem({ item_key: key, label, category: 'General', severity_if_defect: 'major', sort_order: sortOrder });
      setNewLabel('');
      await load();
    } catch (e) {
      toast(errorMessage(e, 'Could not add the item'), 'error');
    } finally {
      setAdding(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
        {error}
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => void load()}>
          <RefreshCw size={14} /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">
        Items marked <strong>Out of service</strong> require a photo and automatically block dispatch for that technician until the
        defect is resolved. Past inspections keep the wording they were signed with.
      </p>

      {items.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="No checklist items yet" description="Add your first item below." />
      ) : (
        <ul className="space-y-3">
          {items
            .slice()
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((item) => (
              <ItemEditor key={item.id} item={item} onSaved={(next) => setItems((prev) => prev.map((x) => (x.id === next.id ? next : x)))} />
            ))}
        </ul>
      )}

      {items.length < MAX_ITEMS ? (
        <div className="flex items-end gap-2">
          <Input label="Add checklist item" placeholder="e.g. Backup camera" maxLength={120} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
          <Button onClick={() => void add()} disabled={adding || newLabel.trim().length === 0}>
            <Plus size={16} /> Add
          </Button>
        </div>
      ) : (
        <p className="text-xs text-text-secondary">Maximum of {MAX_ITEMS} items reached. Deactivate items you no longer use.</p>
      )}
    </div>
  );
}
