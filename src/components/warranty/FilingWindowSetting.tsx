import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/contexts/ToastContext';

/**
 * Owner-only: how many days after a repair your claims must be filed. Manufacturer filing windows are not in the
 * warranty data, so auto-detected claims get NO deadline until you set this (never a guess).
 */
export function FilingWindowSetting({ userId, onSaved }: { userId: string; onSaved?: () => void }) {
  const { toast } = useToast();
  const [value, setValue] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('profiles')
      .select('warranty_claim_window_days')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const d = (data as { warranty_claim_window_days: number | null } | null)?.warranty_claim_window_days;
        setValue(d != null ? String(d) : '');
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [userId]);

  const save = async () => {
    const trimmed = value.trim();
    const n = trimmed === '' ? null : Number(trimmed);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 730)) {
      toast('Enter a whole number of days between 1 and 730.', 'error');
      return;
    }
    setSaving(true);
    const { error } = await supabase.from('profiles').update({ warranty_claim_window_days: n }).eq('id', userId);
    setSaving(false);
    if (error) { toast('Could not save the filing window.', 'error'); return; }
    toast('Filing window saved. It applies to newly detected claims.', 'success');
    onSaved?.();
  };

  if (!loaded) return null;
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="min-w-[14rem] flex-1">
        <p className="text-sm font-medium text-text-primary">Default filing window</p>
        <p className="text-xs text-text-secondary">Days after the repair that a claim must be filed. Leave blank if you’d rather enter each deadline yourself.</p>
      </div>
      <input
        type="number" min={1} max={730} value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 60"
        aria-label="Default filing window in days"
        className="focus-ring w-24 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
      />
      <button type="button" onClick={() => void save()} disabled={saving} className="focus-ring rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50">
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
