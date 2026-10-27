import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  dist, formatArea, formatLength, parseLength, polygonArea, polygonPerimeter, setOpeningKind, setOpeningWidth, setWallLength,
  updateNoteText, updateRoomName, wallLength, type SketchDoc, type SketchSelection,
} from '@/lib/siteSketch';

const field =
  'focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-base text-text-primary disabled:opacity-60';

export function LengthField({ id, label, valueMm, unit, disabled, onCommit }: {
  id: string; label: string; valueMm: number; unit: SketchDoc['unit']; disabled?: boolean; onCommit: (mm: number) => void;
}) {
  const shown = formatLength(valueMm, unit);
  const [text, setText] = useState(shown);
  const [error, setError] = useState(false);
  useEffect(() => {
    setText(shown);
    setError(false);
  }, [shown, id]);

  const commit = () => {
    if (text.trim() === shown) return setError(false);
    const mm = parseLength(text, unit);
    if (mm === null) return setError(true);
    setError(false);
    onCommit(mm);
  };

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-text-secondary">{label}</label>
      <input
        id={id}
        className={`${field} ${error ? 'border-danger' : ''}`}
        value={text}
        disabled={disabled}
        inputMode="text"
        autoComplete="off"
        aria-invalid={error}
        aria-describedby={error ? `${id}-err` : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      {error && (
        <p id={`${id}-err`} role="alert" className="mt-1 text-xs text-danger">
          Try {unit === 'imperial' ? `12'6", 150in or 3.2m` : '3.2 m, 320 cm or 3200 mm'}.
        </p>
      )}
    </div>
  );
}

interface Props {
  doc: SketchDoc;
  selection: SketchSelection;
  readOnly?: boolean;
  onChange: (doc: SketchDoc) => void;
  onDelete: () => void;
}

export function SketchInspector({ doc, selection, readOnly, onChange, onDelete }: Props) {
  if (!selection) {
    return <p className="text-sm text-text-secondary">Tap a wall, room, door, window or note to edit it. Tap a wall to type the length you measured.</p>;
  }
  const del = (
    <button type="button" onClick={onDelete} disabled={readOnly} className="focus-ring inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-danger/40 px-3 text-sm font-semibold text-danger hover:bg-danger/10 disabled:opacity-50">
      <Trash2 size={15} aria-hidden="true" /> Delete
    </button>
  );
  const unit = doc.unit;

  if (selection.kind === 'wall') {
    const w = doc.walls.find((x) => x.id === selection.id);
    if (!w) return null;
    return (
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[160px] flex-1">
          <LengthField id={`len-${w.id}`} label="Wall length" valueMm={wallLength(w)} unit={unit} disabled={readOnly} onCommit={(mm) => onChange(setWallLength(doc, w.id, mm))} />
        </div>
        {del}
      </div>
    );
  }
  if (selection.kind === 'dimension') {
    const d = doc.dimensions.find((x) => x.id === selection.id);
    if (!d) return null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-primary">Measured distance: <span className="font-semibold">{formatLength(dist(d.a, d.b), unit)}</span></p>
        {del}
      </div>
    );
  }
  if (selection.kind === 'room') {
    const r = doc.rooms.find((x) => x.id === selection.id);
    if (!r) return null;
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[160px] flex-1">
            <label htmlFor={`room-${r.id}`} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-text-secondary">Room name</label>
            <input id={`room-${r.id}`} className={field} maxLength={60} value={r.name} disabled={readOnly} onChange={(e) => onChange(updateRoomName(doc, r.id, e.target.value))} />
          </div>
          {del}
        </div>
        <p className="text-sm text-text-secondary">
          Floor area <span className="font-semibold text-text-primary">{formatArea(polygonArea(r.points), unit)}</span> · Perimeter{' '}
          <span className="font-semibold text-text-primary">{formatLength(polygonPerimeter(r.points), unit)}</span>
        </p>
      </div>
    );
  }
  if (selection.kind === 'opening') {
    const o = doc.openings.find((x) => x.id === selection.id);
    if (!o) return null;
    return (
      <div className="flex flex-wrap items-end gap-3">
        <div className="inline-flex rounded-xl border border-border p-0.5" role="group" aria-label="Opening type">
          {(['door', 'window'] as const).map((k) => (
            <button key={k} type="button" disabled={readOnly} aria-pressed={o.kind === k} onClick={() => onChange(setOpeningKind(doc, o.id, k))}
              className={`focus-ring min-h-[40px] rounded-lg px-3 text-sm font-semibold capitalize ${o.kind === k ? 'bg-accent text-white' : 'text-text-secondary'}`}>
              {k}
            </button>
          ))}
        </div>
        <div className="min-w-[140px] flex-1">
          <LengthField id={`ow-${o.id}`} label="Width" valueMm={o.width_mm} unit={unit} disabled={readOnly} onCommit={(mm) => onChange(setOpeningWidth(doc, o.id, mm))} />
        </div>
        {del}
      </div>
    );
  }
  const n = doc.notes.find((x) => x.id === selection.id);
  if (!n) return null;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[160px] flex-1">
        <label htmlFor={`note-${n.id}`} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-text-secondary">Note</label>
        <input id={`note-${n.id}`} className={field} maxLength={200} value={n.text} disabled={readOnly} onChange={(e) => onChange(updateNoteText(doc, n.id, e.target.value))} />
      </div>
      {del}
    </div>
  );
}
