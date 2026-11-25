import { INDUSTRIES } from '@/lib/industries';
import { parseZipList, polygonError, type LatLng, type ZoneType } from '@/lib/territoryExclusivity/core';
import type { ShapeInput } from '@/lib/territoryExclusivity/api';

export const FIELD = 'w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus-ring';

export interface ShapeDraft { trade: string; zoneType: ZoneType; zipText: string; polyText: string }
export const emptyShape = (): ShapeDraft => ({ trade: INDUSTRIES[0]?.slug ?? 'hvac', zoneType: 'zip', zipText: '', polyText: '' });

/** Parses the draft into an API shape, or returns a message to show next to the form. */
export function shapeFromDraft(d: ShapeDraft): { shape: ShapeInput } | { error: string } {
  if (d.zoneType === 'zip') {
    const { codes, invalid } = parseZipList(d.zipText);
    if (invalid.length) return { error: `Not recognised: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}` };
    if (codes.length === 0) return { error: 'Enter at least one ZIP or postal code.' };
    return { shape: { trade: d.trade, zoneType: 'zip', zipCodes: codes, polygon: null } };
  }
  const pts: LatLng[] = [];
  for (const [i, line] of d.polyText.split('\n').map((l) => l.trim()).filter(Boolean).entries()) {
    const n = line.split(/[,\s]+/).map(Number);
    if (n.length !== 2 || n.some((x) => !Number.isFinite(x))) return { error: `Line ${i + 1} must be “latitude, longitude”.` };
    pts.push([n[0], n[1]]);
  }
  const err = polygonError(pts);
  return err ? { error: err } : { shape: { trade: d.trade, zoneType: 'polygon', zipCodes: [], polygon: pts } };
}

export function TerritoryShapeFields({ value, onChange, idPrefix }: { value: ShapeDraft; onChange: (v: ShapeDraft) => void; idPrefix: string }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-trade`} className="mb-1 block text-sm font-medium">Trade</label>
          <select id={`${idPrefix}-trade`} className={FIELD} value={value.trade} onChange={(e) => onChange({ ...value, trade: e.target.value })}>
            {INDUSTRIES.map((i) => <option key={i.slug} value={i.slug}>{i.slug}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-type`} className="mb-1 block text-sm font-medium">Area defined by</label>
          <select id={`${idPrefix}-type`} className={FIELD} value={value.zoneType} onChange={(e) => onChange({ ...value, zoneType: e.target.value as ZoneType })}>
            <option value="zip">ZIP / postal codes</option>
            <option value="polygon">Polygon (lat, lng points)</option>
          </select>
        </div>
      </div>
      {value.zoneType === 'zip' ? (
        <div>
          <label htmlFor={`${idPrefix}-zips`} className="mb-1 block text-sm font-medium">ZIP / postal codes</label>
          <textarea id={`${idPrefix}-zips`} rows={3} className={FIELD} value={value.zipText} onChange={(e) => onChange({ ...value, zipText: e.target.value })} placeholder="10001, 10002, K1A" />
          <p className="mt-1 text-xs text-text-secondary">US ZIP, Canadian postal code, or a 3-character Canadian FSA (covers every code under it).</p>
        </div>
      ) : (
        <div>
          <label htmlFor={`${idPrefix}-poly`} className="mb-1 block text-sm font-medium">Polygon points, one “latitude, longitude” per line</label>
          <textarea id={`${idPrefix}-poly`} rows={4} className={FIELD} value={value.polyText} onChange={(e) => onChange({ ...value, polyText: e.target.value })} />
        </div>
      )}
    </div>
  );
}
