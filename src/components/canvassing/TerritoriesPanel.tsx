import { useMemo, useState } from 'react';
import { Archive, ArchiveRestore, MapPinned, Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { TERRITORY_COLORS, coverage, parseZoneList, type Door, type Rep, type Territory } from '@/lib/canvassing';
import { saveTerritory, setTerritoryArchived } from '@/lib/canvassingApi';
import { ProgressBar, Sheet, TerritoryDot, selectCls } from './canvassUi';

interface TerritoriesPanelProps {
  isManager: boolean;
  territories: Territory[];
  doors: Door[];
  reps: Rep[];
  onChanged: () => Promise<void>;
}

interface Draft { name: string; color: string; zones: string; assigned: string; notes: string }
const EMPTY: Draft = { name: '', color: TERRITORY_COLORS[0], zones: '', assigned: '', notes: '' };

export function TerritoriesPanel({ isManager, territories, doors, reps, onChanged }: TerritoriesPanelProps) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<Territory | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archiving, setArchiving] = useState<Territory | null>(null);

  const repName = useMemo(() => new Map(reps.map((r) => [r.user_id, r.name])), [reps]);
  const visible = territories.filter((t) => showArchived || t.status === 'active');
  const archivedCount = territories.filter((t) => t.status === 'archived').length;
  const zonesParsed = useMemo(() => parseZoneList(draft.zones), [draft.zones]);

  const open = (t: Territory | 'new') => {
    setEditing(t);
    setNameError(null);
    setFormError(null);
    setDraft(t === 'new' ? EMPTY : { name: t.name, color: t.color, zones: t.zip_codes.join(', '), assigned: t.assigned_user_id ?? '', notes: t.notes ?? '' });
  };

  const save = async () => {
    if (saving) return;
    setFormError(null);
    if (!draft.name.trim()) { setNameError('Give the territory a name.'); return; }
    if (zonesParsed.invalid.length > 0) { setFormError(`Not a ZIP or postal code: ${zonesParsed.invalid.slice(0, 5).join(', ')}`); return; }
    setSaving(true);
    try {
      const res = await saveTerritory(editing && editing !== 'new' ? editing.id : null, {
        name: draft.name, color: draft.color, zip_codes: zonesParsed.zones, assigned_user_id: draft.assigned || null, notes: draft.notes,
      });
      toast(res.claimed > 0 ? `Territory saved. ${res.claimed} unassigned ${res.claimed === 1 ? 'door' : 'doors'} joined it.` : 'Territory saved.', 'success');
      setEditing(null);
      await onChanged();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save the territory.');
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async (t: Territory) => {
    try {
      await setTerritoryArchived(t.id, t.status === 'active');
      toast(t.status === 'active' ? 'Territory archived.' : 'Territory restored.', 'success');
      await onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update the territory.', 'error');
    }
  };

  if (territories.length === 0) {
    return isManager ? (
      <>
        <EmptyState icon={MapPinned} title="No territories yet" description="Split your service area into territories by ZIP code and give each one to a rep. New doors in those ZIP codes join automatically."
          action={{ label: 'Create territory', onClick: () => open('new') }} />
        {renderSheet()}
      </>
    ) : (
      <EmptyState icon={MapPinned} title="No territory assigned yet" description="When your manager assigns you a territory it appears here with its doors." />
    );
  }

  function renderSheet() {
    return (
      <Sheet open={editing !== null} title={editing === 'new' ? 'New territory' : 'Edit territory'} onClose={() => setEditing(null)}
        footer={<>
          <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={() => setEditing(null)}>Cancel</Button>
          <Button type="button" size="sm" className="flex-1" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save territory'}</Button>
        </>}>
        <div className="space-y-4">
          <Input label="Name" value={draft.name} onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setNameError(null); }} error={nameError ?? undefined} maxLength={80} required />
          <fieldset>
            <legend className="text-sm font-medium text-text-primary">Colour</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {TERRITORY_COLORS.map((c) => (
                <label key={c} className={`focus-within:ring-2 focus-within:ring-accent/50 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border-2 ${draft.color === c ? 'border-text-primary' : 'border-transparent'}`}>
                  <input type="radio" name="territory-color" value={c} checked={draft.color === c} onChange={() => setDraft({ ...draft, color: c })} className="sr-only" aria-label={`Colour ${c}`} />
                  <span className="h-6 w-6 rounded-full" style={{ backgroundColor: c }} />
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm font-medium text-text-primary">Assigned rep
            <select value={draft.assigned} onChange={(e) => setDraft({ ...draft, assigned: e.target.value })} className={selectCls}>
              <option value="">Unassigned</option>
              {reps.map((r) => <option key={r.user_id} value={r.user_id}>{r.name}</option>)}
            </select>
          </label>
          <div>
            <Textarea label="ZIP / postal codes" value={draft.zones} onChange={(e) => setDraft({ ...draft, zones: e.target.value })} rows={3} placeholder="78701, 78702, M5V"
              helperText="Separate with commas or spaces. Doors in these ZIP codes join this territory automatically." />
            {draft.zones.trim() && (
              <p role="status" className={`mt-1.5 text-xs ${zonesParsed.invalid.length ? 'text-danger' : 'text-text-secondary'}`}>
                {zonesParsed.zones.length} {zonesParsed.zones.length === 1 ? 'zone' : 'zones'} recognised{zonesParsed.invalid.length ? ` · not recognised: ${zonesParsed.invalid.slice(0, 5).join(', ')}` : ''}
              </p>
            )}
          </div>
          <Textarea label="Notes (optional)" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={2} maxLength={1000} />
          {formError && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-3.5 py-2.5 text-sm text-danger">{formError}</p>}
        </div>
      </Sheet>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">{isManager ? 'Give each rep a territory. Their map and follow-ups only show what is theirs.' : 'Territories assigned to you.'}</p>
        <div className="flex items-center gap-2">
          {isManager && archivedCount > 0 && (
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="focus-ring h-4 w-4 rounded border-border" />
              Show archived ({archivedCount})
            </label>
          )}
          {isManager && <Button type="button" size="sm" onClick={() => open('new')}><Plus size={16} aria-hidden="true" />New territory</Button>}
        </div>
      </div>

      <ul className="grid gap-4 md:grid-cols-2">
        {visible.map((t) => {
          const own = doors.filter((d) => d.territory_id === t.id);
          const cov = coverage(own);
          const archived = t.status === 'archived';
          return (
            <li key={t.id} className={`rounded-2xl border border-border bg-bg-secondary p-5 ${archived ? 'opacity-70' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary"><TerritoryDot color={t.color} className="!h-3 !w-3" /><span className="truncate">{t.name}</span>{archived && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">Archived</span>}</h3>
                  <p className="mt-1 text-sm text-text-secondary">{t.assigned_user_id ? (repName.get(t.assigned_user_id) ?? 'Assigned') : 'Unassigned'}</p>
                </div>
                {isManager && (
                  <div className="flex shrink-0 gap-1">
                    {!archived && <button type="button" aria-label={`Edit ${t.name}`} onClick={() => open(t)} className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"><Pencil size={16} /></button>}
                    <button type="button" aria-label={`${archived ? 'Restore' : 'Archive'} ${t.name}`} onClick={() => (archived ? void toggleArchive(t) : setArchiving(t))}
                      className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary">{archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}</button>
                  </div>
                )}
              </div>
              {t.zip_codes.length > 0 && (
                <p className="mt-3 flex flex-wrap gap-1.5">
                  {t.zip_codes.slice(0, 8).map((z) => <span key={z} className="rounded-md bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">{z}</span>)}
                  {t.zip_codes.length > 8 && <span className="px-1 py-0.5 text-xs text-text-secondary">+{t.zip_codes.length - 8} more</span>}
                </p>
              )}
              <div className="mt-4">
                <div className="mb-1.5 flex items-center justify-between text-xs text-text-secondary">
                  <span>{cov.knocked.toLocaleString()} of {cov.total.toLocaleString()} doors knocked</span><span className="tabular-nums">{cov.pct}%</span>
                </div>
                <ProgressBar value={cov.pct} label={`${t.name} coverage`} color={t.color} />
              </div>
              {t.notes && <p className="mt-3 text-xs leading-relaxed text-text-secondary">{t.notes}</p>}
            </li>
          );
        })}
      </ul>

      {renderSheet()}
      <ConfirmDialog open={archiving !== null} title="Archive this territory?" confirmLabel="Archive"
        description="Its doors and history stay. The assigned rep stops seeing it until you restore it."
        onCancel={() => setArchiving(null)} onConfirm={async () => { const t = archiving; setArchiving(null); if (t) await toggleArchive(t); }} />
    </div>
  );
}
