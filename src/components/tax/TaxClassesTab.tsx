import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, X } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { US_STATES } from '@/lib/salesTax';
import { deleteTaxClass, fetchTaxClasses, saveTaxClass, setTaxClassStateRule, type TaxClassDetail } from '@/lib/salesTaxApi';

const inputClass = 'focus-ring rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
const STATES = Object.entries(US_STATES).sort(([a], [b]) => a.localeCompare(b));

function ClassCard({ cls, onChanged }: { cls: TaxClassDetail; onChanged: () => void }) {
  const { toast } = useToast();
  const [state, setState] = useState('');
  const [taxable, setTaxable] = useState(true);
  const run = async (fn: () => Promise<void>) => {
    try { await fn(); onChanged(); } catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); }
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text-primary">{cls.name} <span className="ml-1 text-xs font-normal text-text-secondary">({cls.code})</span></p>
          {cls.description && <p className="text-xs text-text-secondary">{cls.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            Taxable by default
            <input type="checkbox" checked={cls.defaultTaxable} onChange={(e) => void run(() => saveTaxClass({ id: cls.id, code: cls.code, name: cls.name, description: cls.description ?? '', defaultTaxable: e.target.checked }))} />
          </label>
          {cls.code !== 'general' && (
            <button type="button" aria-label={`Delete ${cls.name}`} onClick={() => void run(() => deleteTaxClass(cls.id))} className="focus-ring rounded p-1 text-text-secondary hover:text-danger"><Trash2 size={14} /></button>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {Object.entries(cls.stateRules).sort().map(([code, t]) => (
          <span key={code} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${t ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}>
            {code}: {t ? 'taxable' : 'not taxable'}
            <button type="button" aria-label={`Remove ${code} rule`} onClick={() => void run(() => setTaxClassStateRule(cls.id, code, null))}><X size={10} /></button>
          </span>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select aria-label="State rule" value={state} onChange={(e) => setState(e.target.value)} className={inputClass}>
          <option value="">Add a state rule…</option>
          {STATES.map(([c, n]) => <option key={c} value={c}>{c} — {n}</option>)}
        </select>
        <select aria-label="Taxability" value={taxable ? 'yes' : 'no'} onChange={(e) => setTaxable(e.target.value === 'yes')} className={inputClass}>
          <option value="yes">Taxable</option><option value="no">Not taxable</option>
        </select>
        <button type="button" disabled={!state} onClick={() => void run(async () => { await setTaxClassStateRule(cls.id, state, taxable); setState(''); })} className="focus-ring rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-primary disabled:opacity-50">Set rule</button>
      </div>
    </div>
  );
}

export function TaxClassesTab() {
  const { toast } = useToast();
  const [classes, setClasses] = useState<TaxClassDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ code: '', name: '', defaultTaxable: true });

  const load = useCallback(async () => {
    try { setClasses(await fetchTaxClasses()); } catch { toast('Could not load tax classes.', 'error'); } finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    try {
      await saveTaxClass(draft);
      setDraft({ code: '', name: '', defaultTaxable: true });
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not add the class.', 'error'); }
  };

  if (loading) return <div className="flex h-24 items-center justify-center"><Loader2 className="animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <p className="text-xs text-text-secondary">
        Tag each quote/invoice line with a class. Taxability differs by state — for example labor is exempt in many states but taxed in a few. Set the default here, then add per-state overrides, and confirm the rules with your tax advisor.
      </p>
      {classes.map((c) => <ClassCard key={c.id} cls={c} onChanged={load} />)}
      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-dashed border-border p-4">
        <input aria-label="Class name" placeholder="Name (e.g. Disposal fee)" className={inputClass} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value, code: draft.code || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) })} />
        <input aria-label="Class code" placeholder="code" className={inputClass} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
        <label className="flex items-center gap-1.5 text-xs text-text-secondary"><input type="checkbox" checked={draft.defaultTaxable} onChange={(e) => setDraft({ ...draft, defaultTaxable: e.target.checked })} /> Taxable by default</label>
        <button type="button" disabled={!draft.name.trim() || !draft.code.trim()} onClick={add} className="focus-ring inline-flex items-center gap-1 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50"><Plus size={12} /> Add class</button>
      </div>
    </div>
  );
}
