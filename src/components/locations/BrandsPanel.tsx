import { useState } from 'react';
import { Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { createBrand, deleteBrand, updateBrand } from '@/lib/locationsApi';
import { validateBrand, type Brand } from '@/lib/locations';

interface Editing {
  id: string | null;
  name: string;
  website: string;
  color: string;
}

/** Brands umbrella: create, rename, recolor and delete. Deleting a brand keeps its locations (they become brand-less). */
export function BrandsPanel({ brands, onChanged }: { brands: Brand[]; onChanged: () => Promise<void> | void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<Brand | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing || saving) return;
    const problem = validateBrand(editing.name, editing.website, editing.color, brands, editing.id);
    setError(problem);
    if (problem) return;
    setSaving(true);
    try {
      if (editing.id) await updateBrand(editing.id, editing.name, editing.website, editing.color);
      else await createBrand(editing.name, editing.website, editing.color);
      toast(editing.id ? 'Brand saved.' : 'Brand created.', 'success');
      setEditing(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the brand.');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    try {
      await deleteBrand(toDelete.id);
      toast('Brand deleted. Its locations were kept.', 'success');
      await onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the brand.', 'error');
    } finally {
      setToDelete(null);
    }
  };

  return (
    <section aria-labelledby="brands-heading" className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="brands-heading" className="flex items-center gap-2 text-base font-semibold text-text-primary">
            <Tag size={16} className="text-accent" aria-hidden="true" /> Brands
          </h2>
          <p className="mt-0.5 text-xs text-text-secondary">Group locations under one or more brands. Optional.</p>
        </div>
        {!editing && (
          <Button size="sm" variant="secondary" onClick={() => { setError(null); setEditing({ id: null, name: '', website: '', color: '' }); }}>
            <Plus size={14} aria-hidden="true" /> Add brand
          </Button>
        )}
      </div>

      {editing && (
        <form onSubmit={save} noValidate className="mt-4 rounded-xl border border-border bg-bg-primary p-3.5 sm:p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Input label="Brand name" required autoFocus maxLength={80} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <Input label="Website" type="url" inputMode="url" placeholder="https://" value={editing.website} onChange={(e) => setEditing({ ...editing, website: e.target.value })} />
            <Input label="Brand color" placeholder="#2563EB" maxLength={7} value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} />
          </div>
          {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
          <div className="mt-3 flex gap-2">
            <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : editing.id ? 'Save brand' : 'Create brand'}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </form>
      )}

      {brands.length === 0 && !editing ? (
        <p className="mt-4 rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-text-secondary">
          No brands yet. Add one if you operate more than one brand.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {brands.map((b) => (
            <li key={b.id} className="flex items-center gap-3 py-2.5">
              <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-border" style={{ backgroundColor: b.primary_color ?? 'transparent' }} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text-primary">{b.name}</p>
                <p className="truncate text-[11px] text-text-secondary">
                  {b.location_count === 1 ? '1 location' : `${b.location_count} locations`}
                  {b.website_url ? ` · ${b.website_url.replace(/^https?:\/\//, '')}` : ''}
                </p>
              </div>
              <Button size="sm" variant="ghost" aria-label={`Edit ${b.name}`} onClick={() => { setError(null); setEditing({ id: b.id, name: b.name, website: b.website_url ?? '', color: b.primary_color ?? '' }); }}>
                <Pencil size={14} aria-hidden="true" />
              </Button>
              <Button size="sm" variant="ghost" aria-label={`Delete ${b.name}`} className="text-danger hover:text-danger" onClick={() => setToDelete(b)}>
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title={`Delete ${toDelete?.name ?? 'brand'}?`}
        description="The brand is removed. Its locations are kept and simply show no brand."
        confirmLabel="Yes, delete brand"
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
      />
    </section>
  );
}
