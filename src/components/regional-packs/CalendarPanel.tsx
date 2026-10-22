import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { addClosure, deleteClosure, fetchClosures, type ClosureRow } from '@/lib/regionalPacksApi';
import { countriesInPack, getCountry } from '@/lib/regionalPacks/packData';
import { DE_STATES, calendarInfo, holidaysFor, isValidIso } from '@/lib/regionalPacks/packHolidays';
import type { PackCode } from '@/lib/regionalPacks/packTypes';

const inputCls = 'w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent';
const labelCls = 'mb-1 block text-xs font-medium text-text-secondary';
const COVERAGE_LABEL = { full: 'Full national calendar', national_core: 'National core days', minimal: 'Minimal — add your own days' } as const;

export function CalendarPanel({ enabledPacks, canManage }: { enabledPacks: PackCode[]; canManage: boolean }) {
  const { toast } = useToast();
  const countries = useMemo(() => enabledPacks.flatMap((p) => countriesInPack(p)), [enabledPacks]);
  const thisYear = new Date().getUTCFullYear();
  const [country, setCountry] = useState(countries[0]?.code ?? 'US');
  const [sub, setSub] = useState('');
  const [year, setYear] = useState(thisYear);
  const [closures, setClosures] = useState<ClosureRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ date: '', name: '', closed: true });
  const [busy, setBusy] = useState(false);

  const profile = getCountry(country);
  const subs = country === 'DE' ? DE_STATES : profile?.subdivisions;
  const info = calendarInfo(country);
  const list = useMemo(() => holidaysFor(country, year, sub || null), [country, year, sub]);

  const load = useCallback(async () => {
    try { setClosures(await fetchClosures(country)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load custom closures.'); }
  }, [country]);
  useEffect(() => { setClosures(null); void load(); }, [load]);

  if (enabledPacks.length === 0) return <EmptyState icon={CalendarDays} title="Enable a regional pack first" description="Holiday calendars appear for the countries of your enabled packs." />;

  const add = async () => {
    if (!isValidIso(draft.date) || !draft.name.trim()) { toast('Pick a date and give it a name.', 'error'); return; }
    setBusy(true);
    try { await addClosure(country, draft.date, draft.name, draft.closed); setDraft({ date: '', name: '', closed: true }); await load(); toast('Saved.', 'success'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not save.', 'error'); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try { await deleteClosure(id); await load(); } catch (e) { toast(e instanceof Error ? e.message : 'Could not delete.', 'error'); }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section aria-labelledby="hol-h" className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
        <h2 id="hol-h" className="text-base font-semibold text-text-primary">Holiday calendar</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div><label className={labelCls} htmlFor="cal-c">Country</label>
            <select id="cal-c" className={inputCls} value={country} onChange={(e) => { setCountry(e.target.value); setSub(''); }}>{countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></div>
          <div><label className={labelCls} htmlFor="cal-s">Region</label>
            <select id="cal-s" className={inputCls} value={sub} disabled={!subs} onChange={(e) => setSub(e.target.value)}><option value="">{subs ? 'National' : '—'}</option>{subs && Object.entries(subs).map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></div>
          <div><label className={labelCls} htmlFor="cal-y">Year</label>
            <select id="cal-y" className={inputCls} value={year} onChange={(e) => setYear(Number(e.target.value))}>{[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map((y) => <option key={y} value={y}>{y}</option>)}</select></div>
        </div>
        <p className="mt-3 inline-flex rounded-full border border-border px-2.5 py-1 text-xs text-text-secondary">{COVERAGE_LABEL[info.coverage]}</p>
        {info.note && <p className="mt-2 flex items-start gap-2 text-xs text-text-secondary"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" /> {info.note}</p>}
        <ul className="mt-3 divide-y divide-border">
          {list.map((h) => (
            <li key={`${h.date}${h.name}`} className="flex items-start justify-between gap-3 py-2 text-sm">
              <span className="text-text-primary">{h.name}{h.kind === 'observance' && <span className="ml-2 text-xs text-text-secondary">(not a day off)</span>}{h.observedFrom && <span className="ml-2 text-xs text-text-secondary">(observed; falls on {h.observedFrom})</span>}</span>
              <time dateTime={h.date} className="shrink-0 tabular-nums text-text-secondary">{h.date}</time>
            </li>
          ))}
          {list.length === 0 && <li className="py-3 text-sm text-text-secondary">No holidays for this selection.</li>}
        </ul>
      </section>

      <section aria-labelledby="clo-h" className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
        <h2 id="clo-h" className="text-base font-semibold text-text-primary">Your closures · {profile?.name}</h2>
        <p className="text-sm text-text-secondary">Add local holidays, company shutdowns, or mark a normal holiday as open.</p>
        {error && <p role="alert" className="mt-2 text-sm text-danger">{error} <button className="underline" onClick={() => void load()}>Retry</button></p>}
        {canManage && (
          <div className="mt-3 grid gap-3 sm:grid-cols-[9rem_1fr]">
            <div><label className={labelCls} htmlFor="cl-d">Date</label><input id="cl-d" type="date" className={inputCls} value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} /></div>
            <div><label className={labelCls} htmlFor="cl-n">Name</label><input id="cl-n" className={inputCls} maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
            <label className="flex items-center gap-2 text-sm text-text-primary sm:col-span-2"><input type="checkbox" checked={draft.closed} onChange={(e) => setDraft({ ...draft, closed: e.target.checked })} /> We are closed (untick = we are open on a normal holiday)</label>
            <Button size="sm" className="sm:col-span-2 sm:w-fit" onClick={() => void add()} disabled={busy}><Plus size={16} aria-hidden="true" /> Add</Button>
          </div>
        )}
        <ul className="mt-4 divide-y divide-border">
          {(closures ?? []).map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 truncate text-text-primary">{c.name} <span className="text-xs text-text-secondary">· {c.closed ? 'closed' : 'open'}</span></span>
              <span className="flex items-center gap-2"><time dateTime={c.date} className="tabular-nums text-text-secondary">{c.date}</time>
                {canManage && <button className="rounded p-1 text-text-secondary hover:text-danger" aria-label={`Delete ${c.name}`} onClick={() => void remove(c.id)}><Trash2 size={16} aria-hidden="true" /></button>}</span>
            </li>
          ))}
          {closures && closures.length === 0 && <li className="py-3 text-sm text-text-secondary">No custom closures yet.</li>}
          {!closures && !error && <li className="py-3 text-sm text-text-secondary">Loading…</li>}
        </ul>
      </section>
    </div>
  );
}
