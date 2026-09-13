import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Check, X, Target } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

interface CallSource {
  id: string;
  vapi_phone_number_id: string;
  label: string;
}

/**
 * Self-contained on purpose (own fetch, own save) so it can be dropped into
 * BusinessProfilePage.tsx with one line, without touching that page's
 * existing state or its big batched handleSave. Mirrors LeadSourceBreakdown
 * (src/components/LeadSourceBreakdown.tsx) and 20260912070000 migration.
 *
 * Requires the business to have already created an additional phone number
 * for this channel in the Vapi dashboard and forwarded it appropriately —
 * this widget only records the mapping, it doesn't provision numbers.
 */
export function CallSourcesManager() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [sources, setSources] = useState<CallSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newPhoneId, setNewPhoneId] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchSources = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('call_sources')
      .select('id, vapi_phone_number_id, label')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });
    if (!error) setSources((data as CallSource[]) || []);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  const handleAdd = async () => {
    if (!user || !newLabel.trim() || !newPhoneId.trim()) return;
    setSaving(true);
    const { error } = await supabase
      .from('call_sources')
      .insert({ user_id: user.id, label: newLabel.trim(), vapi_phone_number_id: newPhoneId.trim() });
    setSaving(false);
    if (error) {
      toast(error.message.includes('duplicate') ? 'That phone number ID is already mapped to a source' : 'Could not add this source', 'error');
      return;
    }
    setNewLabel('');
    setNewPhoneId('');
    setAdding(false);
    toast('Call source added', 'success');
    fetchSources();
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from('call_sources').delete().eq('id', id);
    if (error) {
      toast('Could not remove this source', 'error');
      return;
    }
    fetchSources();
  };

  return (
    <div>
      <p className="mb-3 text-xs leading-relaxed text-text-secondary">
        Each row maps a phone number ID from your Vapi dashboard to a channel name, so calls to that
        number get tagged with that source in Analytics. If you only use one phone number, you can
        skip this — those calls just show as &ldquo;Direct / Not tracked.&rdquo;
      </p>

      {loading ? (
        <div className="h-10 animate-pulse rounded-xl bg-bg-tertiary" />
      ) : (
        <div className="space-y-2">
          {sources.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary px-3 py-2">
              <div className="flex items-center gap-2 overflow-hidden">
                <Target size={14} className="shrink-0 text-accent" />
                <span className="truncate text-sm font-medium text-text-primary">{s.label}</span>
                <span className="truncate text-xs text-text-secondary">({s.vapi_phone_number_id})</span>
              </div>
              <button
                type="button"
                onClick={() => handleDelete(s.id)}
                className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger"
                aria-label="Remove"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="mt-2 rounded-xl border border-border bg-bg-primary p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Channel name, e.g. Google Business Profile"
              className={inputClass}
            />
            <input
              type="text"
              value={newPhoneId}
              onChange={(e) => setNewPhoneId(e.target.value)}
              placeholder="Vapi phone number ID"
              className={inputClass}
            />
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="focus-ring flex items-center gap-1 rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
            >
              <X size={14} /> Cancel
            </button>
            <button
              type="button"
              disabled={saving || !newLabel.trim() || !newPhoneId.trim()}
              onClick={handleAdd}
              className="focus-ring flex items-center gap-1 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
            >
              <Check size={14} /> Save source
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="focus-ring mt-2 flex items-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
        >
          <Plus size={14} /> Add call source
        </button>
      )}
    </div>
  );
}
