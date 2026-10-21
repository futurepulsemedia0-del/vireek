import { useState } from 'react';
import { Circle, Hexagon, MapPinOff, Pencil, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  ETA_PLACEHOLDERS, MAX_TEMPLATE_LENGTH, ZONE_COLORS, ZONE_TYPES, ZONE_TYPE_META, defaultAutomations, describeAutomations, formatArea,
  formatDistance, polygonAreaM2, previewEtaTemplate, relativeTime, summarizeActions, validateDraft,
  type AutomationConfig, type Geofence, type GeofenceDraft, type ZoneEventRow, type ZoneShape, type ZoneType,
} from '@/lib/geofences';

interface GeofencePanelProps {
  zones: Geofence[];
  events: ZoneEventRow[];
  loading: boolean;
  error: string | null;
  eventsError: string | null;
  canManage: boolean;
  draft: GeofenceDraft | null;
  drawing: boolean;
  selectedZoneId: string | null;
  vehicleLabels: Map<string, string>;
  /** zone id -> number of vehicles currently inside */
  insideCounts: Map<string, number>;
  nowMs: number;
  saving: boolean;
  saveError: string | null;
  onStartDraw: (shape: ZoneShape) => void;
  onDraftChange: (next: GeofenceDraft) => void;
  onResumeDraw: () => void;
  onUndoPoint: () => void;
  onSave: () => void;
  onCancel: () => void;
  onEdit: (zone: Geofence) => void;
  onSelect: (id: string | null) => void;
  onToggleActive: (zone: Geofence) => Promise<void>;
  onDelete: (zone: Geofence) => Promise<void>;
  onRetry: () => void;
}

const AUTOMATION_ROWS: Array<{ key: 'arrived' | 'clock_in' | 'eta_text' | 'exit_alert'; title: string; when: string; help: string }> = [
  { key: 'arrived', title: 'Mark job arrived', when: 'On entering', help: 'Moves the technician’s scheduled job to in progress with the real arrival time.' },
  { key: 'clock_in', title: 'Clock the technician in', when: 'On entering', help: 'Starts their shift on the time clock. Skipped if they are already clocked in or have no employee record.' },
  { key: 'eta_text', title: 'Text the customer an ETA', when: 'On entering', help: 'Once per job. Honors opt-outs, texting approval and quiet hours; never sent late.' },
  { key: 'exit_alert', title: 'Alert me when a vehicle leaves', when: 'On leaving', help: 'Adds a notification to your dashboard.' },
];

function NumberField({ label, value, onChange, error, help, min, max, step = 1 }: { label: string; value: number; onChange: (n: number) => void; error?: string; help?: string; min: number; max: number; step?: number }) {
  return (
    <Input
      label={label} type="number" inputMode="numeric" min={min} max={max} step={step} value={Number.isFinite(value) ? value : ''}
      onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))} error={error} helperText={help}
    />
  );
}

function ZoneEditor(props: GeofencePanelProps & { draft: GeofenceDraft }) {
  const { draft, drawing, saving, saveError, onDraftChange, onSave, onCancel, onResumeDraw, onUndoPoint } = props;
  const errors = validateDraft(draft);
  const [touched, setTouched] = useState(false);
  const shown = touched ? errors : {};
  const patch = (p: Partial<GeofenceDraft>) => onDraftChange({ ...draft, ...p });
  const setAuto = (p: Partial<AutomationConfig>) => patch({ automations: { ...draft.automations, ...p } });
  const chooseType = (type: ZoneType) => {
    // Switching type re-applies that type's recommended automations (keeps a custom ETA message).
    patch({ type, color: ZONE_TYPE_META[type].color, automations: { ...defaultAutomations(type), eta_template: draft.automations.eta_template } });
  };
  const isCircle = draft.shape === 'circle';

  return (
    <form
      className="space-y-4 rounded-xl border border-accent/40 bg-bg-secondary p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (Object.keys(errors).length === 0) onSave();
      }}
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        {isCircle ? <Circle className="h-4 w-4" aria-hidden /> : <Hexagon className="h-4 w-4" aria-hidden />}
        {draft.id ? 'Edit zone' : isCircle ? 'New circle zone' : 'New polygon zone'}
      </h3>

      <div className="rounded-lg bg-bg-tertiary p-3 text-sm text-text-secondary" role="status">
        {drawing ? (
          isCircle ? 'Click the map to place the center.' : draft.polygon.length < 3 ? `Click the map to add points (${draft.polygon.length} so far, at least 3). Click the first point to finish.` : 'Keep clicking to add points, or click the first point to finish.'
        ) : isCircle ? (
          draft.center ? `Radius ${formatDistance(draft.radiusM)}. Drag the white handle on the circle to resize, or the dot to move it.` : 'No center yet.'
        ) : (
          `${draft.polygon.length} points${draft.polygon.length >= 3 ? ` · ${formatArea(polygonAreaM2(draft.polygon))}` : ''}. Drag points to reshape; right-click a point to remove it.`
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {!drawing && (!isCircle || !draft.center) && <Button type="button" size="sm" variant="secondary" onClick={onResumeDraw}>Add points</Button>}
          {!isCircle && draft.polygon.length > 0 && (
            <Button type="button" size="sm" variant="secondary" onClick={onUndoPoint}><Undo2 className="h-4 w-4" aria-hidden /> Undo last point</Button>
          )}
          {isCircle && draft.center && !drawing && <Button type="button" size="sm" variant="secondary" onClick={onResumeDraw}>Re-place center</Button>}
        </div>
        {shown.shape && <p className="mt-2 text-xs text-danger" role="alert">{shown.shape}</p>}
      </div>

      <Input label="Name" required value={draft.name} maxLength={80} onChange={(e) => patch({ name: e.target.value })} error={shown.name} placeholder="e.g. Main shop, Zone 3 service area" />

      <div>
        <label htmlFor="zone-type" className="mb-1.5 block text-sm font-medium text-text-primary">Type</label>
        <select id="zone-type" value={draft.type} onChange={(e) => chooseType(e.target.value as ZoneType)} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary">
          {ZONE_TYPES.map((t) => <option key={t} value={t}>{ZONE_TYPE_META[t].label}</option>)}
        </select>
        <p className="mt-1.5 text-xs text-text-secondary">{ZONE_TYPE_META[draft.type].hint}</p>
      </div>

      {isCircle && <NumberField label="Radius (meters)" value={draft.radiusM} min={25} max={100000} onChange={(n) => patch({ radiusM: n })} error={shown.radius} help={Number.isFinite(draft.radiusM) ? `≈ ${formatDistance(draft.radiusM)}` : undefined} />}

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-text-primary">Color</legend>
        <div className="flex gap-2">
          {ZONE_COLORS.map((c) => (
            <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={draft.color === c} onClick={() => patch({ color: c })}
              className={`focus-ring h-8 w-8 rounded-full border-2 ${draft.color === c ? 'border-text-primary' : 'border-transparent'}`} style={{ background: c }} />
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-text-primary">Automations</legend>
        {AUTOMATION_ROWS.map((row) => (
          <label key={row.key} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3">
            <input type="checkbox" className="mt-1 h-4 w-4" checked={draft.automations[row.key]} onChange={(e) => setAuto({ [row.key]: e.target.checked } as Partial<AutomationConfig>)} />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-text-primary">{row.title} <span className="text-xs font-normal text-text-secondary">· {row.when}</span></span>
              <span className="block text-xs text-text-secondary">{row.help}</span>
            </span>
          </label>
        ))}
        {draft.automations.eta_text && (
          <div className="space-y-2">
            <Textarea
              label="ETA message (optional)" rows={3} maxLength={MAX_TEMPLATE_LENGTH} value={draft.automations.eta_template}
              onChange={(e) => setAuto({ eta_template: e.target.value })} error={shown.template} placeholder="Leave empty to use the default message"
              helperText={`Placeholders: ${ETA_PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}`}
            />
            <p className="rounded-lg bg-bg-tertiary p-2 text-xs text-text-secondary">Preview: {previewEtaTemplate(draft.automations.eta_template)}</p>
          </div>
        )}
      </fieldset>

      <details className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-text-primary">Sensitivity</summary>
        <div className="mt-3 space-y-3">
          <NumberField label="Confirm entry after (seconds)" value={draft.dwellSeconds} min={0} max={900} onChange={(n) => patch({ dwellSeconds: n })} error={shown.dwell} help="Drive-bys shorter than this don’t count as entering." />
          <NumberField label="Exit buffer (meters)" value={draft.exitBufferM} min={0} max={500} onChange={(n) => patch({ exitBufferM: n })} error={shown.buffer} help="How far outside the edge before leaving counts. Prevents GPS jitter from flapping." />
        </div>
      </details>

      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" className="h-4 w-4" checked={draft.active} onChange={(e) => patch({ active: e.target.checked })} /> Zone is active
      </label>

      {saveError && <p role="alert" className="text-sm text-danger">{saveError}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save zone'}</Button>
        <Button type="button" size="sm" variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </form>
  );
}

export function GeofencePanel(props: GeofencePanelProps) {
  const { zones, events, loading, error, eventsError, canManage, draft, selectedZoneId, vehicleLabels, insideCounts, nowMs, onStartDraw, onEdit, onSelect, onToggleActive, onDelete, onRetry } = props;
  const [toDelete, setToDelete] = useState<Geofence | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <section aria-labelledby="zones-heading" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="zones-heading" className="text-sm font-semibold text-text-primary">Zones ({zones.length})</h2>
        {canManage && !draft && (
          <div className="flex gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => onStartDraw('circle')}><Circle className="h-4 w-4" aria-hidden /> Circle</Button>
            <Button size="sm" variant="secondary" onClick={() => onStartDraw('polygon')}><Hexagon className="h-4 w-4" aria-hidden /> Polygon</Button>
          </div>
        )}
      </div>

      {!canManage && <p className="text-xs text-text-secondary">Only the account owner or a team manager can change zones.</p>}
      {draft && <ZoneEditor {...props} draft={draft} />}
      {actionError && <p role="alert" className="text-sm text-danger">{actionError}</p>}

      {loading ? (
        <p className="text-sm text-text-secondary" role="status">Loading zones…</p>
      ) : error ? (
        <EmptyState icon={TriangleAlert} title="Couldn't load zones" description={error} action={{ label: 'Try again', onClick: onRetry }} />
      ) : zones.length === 0 && !draft ? (
        <EmptyState icon={MapPinOff} title="No zones yet" description="Draw a circle or polygon around a job site, your shop or a service area to automate arrivals, clock-ins and ETA texts." />
      ) : (
        <ul className="space-y-2">
          {zones.map((z) => {
            const inside = insideCounts.get(z.id) ?? 0;
            const autos = describeAutomations(z.automations);
            return (
              <li key={z.id} className={`rounded-xl border p-3 ${z.id === selectedZoneId ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary'} ${z.active ? '' : 'opacity-70'}`}>
                <button type="button" onClick={() => onSelect(z.id === selectedZoneId ? null : z.id)} aria-pressed={z.id === selectedZoneId} className="focus-ring w-full rounded-lg text-left">
                  <span className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: z.color }} aria-hidden />
                      <span className="truncate text-sm font-semibold text-text-primary">{z.name}</span>
                    </span>
                    <span className="shrink-0 text-xs text-text-secondary">{z.active ? (inside > 0 ? `${inside} inside` : ZONE_TYPE_META[z.type].label) : 'Paused'}</span>
                  </span>
                  <span className="mt-1 block truncate text-xs text-text-secondary">
                    {z.shape === 'circle' ? `Circle · ${formatDistance(z.radiusM)}` : `Polygon · ${z.polygon?.length ?? 0} points`}
                    {autos.length > 0 ? ` · ${autos.join(', ')}` : ''}
                  </span>
                </button>
                {canManage && !draft && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => onEdit(z)}><Pencil className="h-4 w-4" aria-hidden /> Edit</Button>
                    <Button size="sm" variant="ghost" onClick={async () => { setActionError(null); try { await onToggleActive(z); } catch (e) { setActionError(e instanceof Error ? e.message : 'Could not update the zone.'); } }}>{z.active ? 'Pause' : 'Resume'}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setToDelete(z)}><Trash2 className="h-4 w-4" aria-hidden /> Delete</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="space-y-2 pt-1">
        <h3 className="text-sm font-semibold text-text-primary">Recent zone activity</h3>
        {eventsError ? (
          <p className="text-xs text-text-secondary" role="status">Activity couldn’t be loaded. {eventsError}</p>
        ) : events.length === 0 ? (
          <p className="text-xs text-text-secondary">No vehicle has entered or left a zone yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {events.map((ev) => (
              <li key={ev.id} className="rounded-lg border border-border bg-bg-secondary p-2.5 text-xs">
                <p className="text-text-primary">
                  <span className="font-medium">{vehicleLabels.get(ev.vehicle_id) ?? 'A vehicle'}</span> {ev.kind === 'enter' ? 'entered' : 'left'} <span className="font-medium">{ev.zone_name}</span>
                  <span className="text-text-secondary"> · {relativeTime(ev.occurred_at, nowMs)}</span>
                </p>
                <p className="text-text-secondary">{summarizeActions(ev.actions)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this zone?"
        description={`“${toDelete?.name ?? ''}” and its automations will stop immediately. Past activity is kept.`}
        confirmLabel="Yes, delete zone"
        onCancel={() => setToDelete(null)}
        onConfirm={async () => {
          const z = toDelete;
          setToDelete(null);
          if (!z) return;
          setActionError(null);
          try { await onDelete(z); } catch (e) { setActionError(e instanceof Error ? e.message : 'Could not delete the zone.'); }
        }}
      />
    </section>
  );
}
