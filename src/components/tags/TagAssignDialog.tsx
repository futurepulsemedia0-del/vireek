import { useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/contexts/ToastContext';
import { assignTag, formatTagToken, tagErrorMessage } from '@/lib/vireekTag';

interface Eq { id: string; equipment_type: string; make: string | null; model: string | null; serial_number: string | null; customer: { name: string } | { name: string }[] | null }

export function TagAssignDialog({ token, onClose, onDone }: { token: string; onClose: () => void; onDone: (passportCode: string) => void }) {
  const { toast } = useToast();
  const [items, setItems] = useState<Eq[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase.from('equipment')
      .select('id, equipment_type, make, model, serial_number, customer:customer_id (name)')
      .eq('status', 'active').order('created_at', { ascending: false }).limit(100)
      .then(({ data }) => { if (!cancelled) { setItems((data as unknown as Eq[]) ?? []); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const custName = (e: Eq) => (Array.isArray(e.customer) ? e.customer[0]?.name : e.customer?.name) ?? '';
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return items;
    return items.filter((e) => [e.make, e.model, e.equipment_type, e.serial_number, custName(e)].some((v) => (v ?? '').toLowerCase().includes(n)));
  }, [items, q]);

  const pick = async (e: Eq) => {
    setBusyId(e.id);
    try {
      const r = await assignTag(token, e.id);
      toast('Tag attached to the machine', 'success');
      onDone(r.passport_code);
    } catch (err) {
      toast(tagErrorMessage(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="tag-assign-title">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="tag-assign-title" className="text-base font-semibold text-text-primary">Attach tag to a machine</h2>
            <p className="font-mono text-xs text-text-secondary">{formatTagToken(token)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-md p-1 text-text-secondary hover:text-text-primary"><X size={16} /></button>
        </div>
        <label className="relative mb-3 block">
          <Search size={14} className="absolute left-3 top-3 text-text-secondary" aria-hidden="true" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search make, model, serial or customer" className="w-full rounded-md border border-border bg-bg-primary py-2.5 pl-9 pr-3 text-sm text-text-primary" />
        </label>
        <ul className="-mx-1 flex-1 space-y-1 overflow-y-auto px-1">
          {loading && <li className="h-16 animate-pulse rounded-lg bg-bg-tertiary" aria-busy="true" />}
          {!loading && shown.length === 0 && <li className="p-3 text-sm text-text-secondary">No matching equipment. Add the machine to a customer first (or scan its data plate in a job).</li>}
          {shown.map((e) => (
            <li key={e.id}>
              <button type="button" disabled={busyId !== null} onClick={() => void pick(e)} className="focus-ring w-full rounded-lg border border-border p-3 text-left hover:border-accent/40 disabled:opacity-60">
                <p className="text-sm font-medium text-text-primary">{[e.make, e.model].filter(Boolean).join(' ') || e.equipment_type}</p>
                <p className="text-xs text-text-secondary">{e.equipment_type}{e.serial_number ? ` · S/N ${e.serial_number}` : ''}{custName(e) ? ` · ${custName(e)}` : ''}</p>
                {busyId === e.id && <p className="mt-1 text-xs text-accent">Attaching…</p>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
