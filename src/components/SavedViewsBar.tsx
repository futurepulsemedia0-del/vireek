import { useEffect, useState } from 'react';
import { Bookmark, Plus, Trash2, ChevronDown } from 'lucide-react';
import { listSavedViews, createSavedView, deleteSavedView, SavedView } from '@/lib/savedViews';
import { useToast } from '@/contexts/ToastContext';

interface SavedViewsBarProps {
  page: SavedView['page'];
  currentFilters: Record<string, unknown>;
  onApply: (filters: Record<string, unknown>) => void;
}

export function SavedViewsBar({ page, currentFilters, onApply }: SavedViewsBarProps) {
  const { toast } = useToast();
  const [views, setViews] = useState<SavedView[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    listSavedViews(page).then(setViews).catch(() => setViews([]));
  }, [page]);

  const handleSave = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const view = await createSavedView(page, name, currentFilters);
      setViews((prev) => [view, ...prev]);
      setNewName('');
      setSaving(false);
      toast('View saved.', 'success');
    } catch {
      toast('Could not save view.', 'error');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteSavedView(id);
      setViews((prev) => prev.filter((v) => v.id !== id));
    } catch {
      toast('Could not delete view.', 'error');
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="focus-ring flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary"
      >
        <Bookmark size={15} />
        Views
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-64 overflow-hidden rounded-xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark">
          <div className="max-h-48 overflow-y-auto">
            {views.length === 0 && (
              <p className="px-3 py-3 text-xs text-text-secondary">No saved views yet.</p>
            )}
            {views.map((v) => (
              <div key={v.id} className="flex items-center justify-between px-3 py-2 hover:bg-bg-tertiary">
                <button
                  type="button"
                  onClick={() => {
                    onApply(v.filters);
                    setOpen(false);
                  }}
                  className="flex-1 truncate text-left text-sm text-text-primary"
                >
                  {v.name}
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(v.id)}
                  className="ml-2 rounded p-1 text-text-secondary hover:text-danger"
                  aria-label={`Delete ${v.name}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className="border-t border-border p-2">
            {saving ? (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                  placeholder="View name…"
                  className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary"
                />
                <button
                  type="button"
                  onClick={handleSave}
                  className="focus-ring rounded-lg bg-accent px-2 py-1.5 text-xs font-medium text-white"
                >
                  Save
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSaving(true)}
                className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-accent hover:bg-bg-tertiary"
              >
                <Plus size={13} /> Save current filters as view
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
