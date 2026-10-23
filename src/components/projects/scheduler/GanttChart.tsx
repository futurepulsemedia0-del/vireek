import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Lock } from 'lucide-react';
import { formatDate, type ProjectPhase } from '@/lib/installProjects';
import {
  ZOOM_PX,
  barGeometry,
  currentWindows,
  endFromDuration,
  headerTicks,
  phaseDuration,
  setPhaseWindow,
  shiftWorkdays,
  snapDate,
  timelineRange,
  xForDate,
  type ConflictSeverity,
  type PathNode,
  type PhaseDependency,
  type ScheduleResult,
  type WorkCalendar,
  type Win,
  type Zoom,
} from '@/lib/projectScheduler';

export const ROW_H = 44;
const TIER_H = 26;
const HEADER_H = TIER_H * 2;
const MOVE_THRESHOLD_PX = 4;

export interface GanttMarker {
  id: string;
  phaseId: string;
  date: string;
  label: string;
  tone: 'done' | 'pending' | 'late' | 'job';
}

export interface GanttChartProps {
  phases: ProjectPhase[];
  dependencies: PhaseDependency[];
  cal: WorkCalendar;
  today: string;
  zoom: Zoom;
  progress: Map<string, number>;
  critical?: Map<string, PathNode>;
  conflicts?: Map<string, ConflictSeverity>;
  crewCounts?: Map<string, number>;
  markers?: GanttMarker[];
  showCritical?: boolean;
  showBaseline?: boolean;
  readOnly?: boolean;
  selectedId?: string | null;
  /** Bump to scroll today into view. */
  scrollSignal?: number;
  onSelect?: (id: string) => void;
  onOpen?: (id: string) => void;
  /** Drag, resize and keyboard moves all end here. A blocked result carries `blocked`. */
  onCommit: (result: ScheduleResult, phaseId: string) => void;
}

type DragMode = 'move' | 'start' | 'end';
interface Drag {
  id: string;
  mode: DragMode;
  orig: Win;
  originX: number;
  delta: number;
}

const BAR_TONE: Record<ProjectPhase['status'], string> = {
  completed: 'bg-success-500',
  in_progress: 'bg-accent',
  blocked: 'bg-danger-500',
  not_started: 'bg-accent/40',
};
const MARKER_TONE: Record<GanttMarker['tone'], string> = {
  done: 'bg-success-500',
  pending: 'bg-text-secondary',
  late: 'bg-danger-500',
  job: 'bg-warning-500',
};

/** Orthogonal connector between two bars, leaving/entering the sides the link type implies. */
function linkPath(type: PhaseDependency['dep_type'], a: { left: number; width: number; row: number }, b: { left: number; width: number; row: number }): string {
  const fromRight = type === 'FS' || type === 'FF';
  const intoLeft = type === 'FS' || type === 'SS';
  const x1 = fromRight ? a.left + a.width : a.left;
  const x2 = intoLeft ? b.left : b.left + b.width;
  const y1 = HEADER_H + a.row * ROW_H + ROW_H / 2;
  const y2 = HEADER_H + b.row * ROW_H + ROW_H / 2;
  const xa = x1 + (fromRight ? 10 : -10);
  const xb = x2 + (intoLeft ? -10 : 10);
  if (fromRight && intoLeft && xa <= xb) return `M${x1},${y1} H${xa} V${y2} H${x2}`;
  const ym = (y1 + y2) / 2;
  return `M${x1},${y1} H${xa} V${ym} H${xb} V${y2} H${x2}`;
}

export function GanttChart(props: GanttChartProps) {
  const { phases, dependencies, cal, today, zoom, progress, critical, conflicts, crewCounts, markers = [], showCritical, showBaseline, readOnly, selectedId, scrollSignal, onSelect, onOpen, onCommit } = props;
  const uid = useId().replace(/:/g, '');
  const px = ZOOM_PX[zoom];
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);

  const sorted = useMemo(() => [...phases].sort((a, b) => a.sort_order - b.sort_order), [phases]);
  const windows = useMemo(() => currentWindows(sorted), [sorted]);

  // Live preview of a drag, including the cascade onto later phases.
  const preview = useMemo<ScheduleResult | null>(() => {
    if (!drag || drag.delta === 0) return null;
    const { id, mode, orig, delta } = drag;
    let s = orig.start;
    let e = orig.end;
    if (mode === 'move') {
      s = snapDate(orig.start, delta, cal);
      e = endFromDuration(s, phaseDuration(orig, cal), cal);
    } else if (mode === 'end') {
      e = snapDate(orig.end, delta, cal);
      if (e < s) e = s;
    } else {
      s = snapDate(orig.start, delta, cal);
      if (s > e) s = e;
    }
    return setPhaseWindow(sorted, dependencies, cal, id, s, e);
  }, [drag, sorted, dependencies, cal]);

  const shown = preview && !preview.blocked ? preview.windows : windows;
  const moving = useMemo(() => new Set(preview && !preview.blocked ? preview.changes.map((c) => c.id) : []), [preview]);

  const range = useMemo(() => {
    const all: Win[] = [...shown.values()];
    for (const p of sorted) if (showBaseline && p.baseline_start && p.baseline_end) all.push({ start: p.baseline_start, end: p.baseline_end });
    return timelineRange(all, today);
  }, [shown, sorted, today, showBaseline]);

  const ticks = useMemo(() => headerTicks(range, zoom), [range, zoom]);
  const totalW = range.days * px;
  const bodyH = sorted.length * ROW_H;
  const rowOf = useMemo(() => new Map(sorted.map((p, i) => [p.id, i])), [sorted]);
  const todayX = xForDate(range, today, px);

  // Bring today (or the first bar) into view on mount and whenever asked.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = [...shown.values()].map((w) => w.start).sort()[0];
    const target = scrollSignal ? today : first && first < today ? first : today;
    el.scrollLeft = Math.max(0, xForDate(range, target, px) - el.clientWidth / 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollSignal, zoom]);

  const begin = (e: React.PointerEvent, p: ProjectPhase, mode: DragMode) => {
    if (e.pointerType === 'touch' || e.button !== 0) return; // touch: tap opens the editor, no accidental drags while scrolling
    const w = windows.get(p.id);
    if (!w) return;
    e.stopPropagation();
    if (readOnly) return;
    if (p.status === 'completed' || p.locked) {
      onCommit(setPhaseWindow(sorted, dependencies, cal, p.id, w.start, w.end), p.id);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const next = { id: p.id, mode, orig: w, originX: e.clientX, delta: 0 };
    dragRef.current = next;
    setDrag(next);
  };

  const track = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const delta = Math.round((e.clientX - d.originX) / px);
    if (delta !== d.delta) {
      dragRef.current = { ...d, delta };
      setDrag(dragRef.current);
    }
  };

  const finish = (e: React.PointerEvent, cancelled = false) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setDrag(null);
    const dx = Math.abs(e.clientX - d.originX);
    if (cancelled) return;
    if (dx < MOVE_THRESHOLD_PX || d.delta === 0) {
      onSelect?.(d.id);
      return;
    }
    if (preview && !preview.blocked) onCommit(preview, d.id);
  };

  const onKey = (e: React.KeyboardEvent, p: ProjectPhase) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen?.(p.id);
      return;
    }
    if (e.key === 'Escape' && dragRef.current) {
      dragRef.current = null;
      setDrag(null);
      return;
    }
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const w = windows.get(p.id);
    if (!dir || !w || readOnly) return;
    e.preventDefault();
    const step = (e.shiftKey ? 5 : 1) * dir;
    if (e.altKey) {
      const end = shiftWorkdays(w.end, step, cal);
      onCommit(setPhaseWindow(sorted, dependencies, cal, p.id, w.start, end < w.start ? w.start : end), p.id);
    } else {
      onCommit(setPhaseWindow(sorted, dependencies, cal, p.id, shiftWorkdays(w.start, step, cal), shiftWorkdays(w.end, step, cal)), p.id);
    }
  };

  const weekendBg =
    zoom !== 'month' && !cal.workWeekends
      ? { backgroundImage: `linear-gradient(to right, transparent ${5 * px}px, rgba(128,128,128,0.10) ${5 * px}px)`, backgroundSize: `${7 * px}px 100%` }
      : undefined;

  return (
    <div className="flex overflow-hidden rounded-2xl border border-border bg-bg-secondary" data-testid="gantt">
      {/* Phase names */}
      <div className="w-[132px] shrink-0 border-r border-border sm:w-[220px]">
        <div style={{ height: HEADER_H }} className="border-b border-border bg-bg-tertiary/40" />
        {sorted.map((p) => {
          const sev = conflicts?.get(p.id);
          return (
            <button
              key={p.id}
              type="button"
              style={{ height: ROW_H }}
              onClick={() => onSelect?.(p.id)}
              className={`focus-ring flex w-full flex-col justify-center border-b border-border/60 px-3 text-left transition-colors hover:bg-bg-tertiary/50 ${selectedId === p.id ? 'bg-accent/10' : ''}`}
            >
              <span className="flex items-center gap-1.5 truncate text-sm font-medium text-text-primary">
                {p.locked && <Lock size={12} className="shrink-0 text-text-secondary" aria-label="Locked" />}
                <span className="truncate">{p.name}</span>
                {sev && <AlertTriangle size={13} className={`shrink-0 ${sev === 'error' ? 'text-danger-500' : 'text-warning-500'}`} aria-label={sev === 'error' ? 'Has errors' : 'Has warnings'} />}
              </span>
              <span className="truncate text-xs text-text-secondary">
                {progress.get(p.id) ?? 0}%{crewCounts?.get(p.id) ? ` · ${crewCounts.get(p.id)} crew` : ''}
              </span>
            </button>
          );
        })}
      </div>

      {/* Timeline */}
      <div ref={scrollRef} className="relative min-w-0 flex-1 overflow-x-auto">
        <p id={`${uid}-help`} className="sr-only">
          Schedule bar. Arrow keys move the phase by one working day, Shift plus arrow by five, Alt plus arrow changes the end date, Enter opens details.
        </p>
        <div className="relative select-none" style={{ width: totalW, height: HEADER_H + bodyH }}>
          {/* Header */}
          {(['top', 'bottom'] as const).map((tier, ti) => (
            <div key={tier} className="absolute left-0 right-0 border-b border-border bg-bg-tertiary/40" style={{ top: ti * TIER_H, height: TIER_H }} aria-hidden="true">
              {ticks[tier].map((t) => (
                <div key={t.key} className="absolute top-0 flex h-full items-center overflow-hidden whitespace-nowrap border-l border-border/60 px-1.5 text-[11px] font-medium text-text-secondary" style={{ left: t.left, width: t.width }}>
                  {t.label}
                </div>
              ))}
            </div>
          ))}

          {/* Body: weekend shading + row lines */}
          <div className="absolute left-0 right-0" style={{ top: HEADER_H, height: bodyH, ...weekendBg }} aria-hidden="true">
            {sorted.map((p, i) => (
              <div key={p.id} className={`absolute left-0 right-0 border-b border-border/60 ${selectedId === p.id ? 'bg-accent/5' : ''}`} style={{ top: i * ROW_H, height: ROW_H }} />
            ))}
          </div>

          {/* Today */}
          {todayX >= 0 && todayX <= totalW && (
            <div className="pointer-events-none absolute z-10 w-0.5 bg-danger-500/70" style={{ left: todayX + px / 2, top: TIER_H, height: HEADER_H - TIER_H + bodyH }} aria-hidden="true">
              <span className="absolute -left-4 top-0 rounded bg-danger-500 px-1 text-[10px] font-semibold text-white">Today</span>
            </div>
          )}

          {/* Dependency arrows */}
          <svg className="pointer-events-none absolute left-0 top-0 z-10" width={totalW} height={HEADER_H + bodyH} aria-hidden="true">
            <defs>
              {(['n', 'c', 'v'] as const).map((k) => (
                <marker key={k} id={`${uid}-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" className={k === 'v' ? 'fill-danger-500' : k === 'c' ? 'fill-accent' : 'fill-text-secondary'} />
                </marker>
              ))}
            </defs>
            {dependencies.map((d) => {
              const wa = shown.get(d.predecessor_id);
              const wb = shown.get(d.successor_id);
              const ra = rowOf.get(d.predecessor_id);
              const rb = rowOf.get(d.successor_id);
              if (!wa || !wb || ra === undefined || rb === undefined) return null;
              const ga = barGeometry(range, wa, px);
              const gb = barGeometry(range, wb, px);
              const bad = (d.dep_type === 'FS' && wb.start <= wa.end) || (d.dep_type === 'SS' && wb.start < wa.start) || (d.dep_type === 'FF' && wb.end < wa.end);
              const crit = !!showCritical && !!critical?.get(d.predecessor_id)?.critical && !!critical?.get(d.successor_id)?.critical;
              const k = bad ? 'v' : crit ? 'c' : 'n';
              return (
                <path
                  key={d.id}
                  d={linkPath(d.dep_type, { ...ga, row: ra }, { ...gb, row: rb })}
                  fill="none"
                  strokeWidth={1.5}
                  markerEnd={`url(#${uid}-${k})`}
                  className={k === 'v' ? 'stroke-danger-500' : k === 'c' ? 'stroke-accent' : 'stroke-text-secondary/70'}
                />
              );
            })}
          </svg>

          {/* Bars */}
          {sorted.map((p, i) => {
            const top = HEADER_H + i * ROW_H;
            const w = shown.get(p.id);
            if (!w) {
              return (
                <button key={p.id} type="button" onClick={() => onOpen?.(p.id)} className="focus-ring absolute z-20 flex items-center rounded-lg border border-dashed border-border px-3 text-xs text-text-secondary hover:border-accent hover:text-text-primary" style={{ left: Math.max(0, todayX), top: top + 9, height: ROW_H - 18 }}>
                  No dates — click to set
                </button>
              );
            }
            const g = barGeometry(range, w, px);
            const pct = progress.get(p.id) ?? 0;
            const node = critical?.get(p.id);
            const isCritical = !!showCritical && !!node?.critical && p.status !== 'completed';
            const sev = conflicts?.get(p.id);
            const fixed = p.status === 'completed' || p.locked === true;
            const base = showBaseline && p.baseline_start && p.baseline_end ? barGeometry(range, { start: p.baseline_start, end: p.baseline_end }, px) : null;
            const label = `${p.name}, ${formatDate(w.start)} to ${formatDate(w.end)}, ${pct}% complete${isCritical ? ', on the critical path' : ''}${sev ? `, ${sev === 'error' ? 'has scheduling errors' : 'has warnings'}` : ''}${p.locked ? ', locked' : ''}`;
            return (
              <div key={p.id}>
                {base && <div className="absolute z-0 h-1.5 rounded-full bg-text-secondary/40" style={{ left: base.left, width: base.width, top: top + ROW_H - 9 }} title="Baseline" aria-hidden="true" />}
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={label}
                  aria-describedby={`${uid}-help`}
                  data-testid={`bar-${p.id}`}
                  onPointerDown={(e) => begin(e, p, 'move')}
                  onPointerMove={track}
                  onPointerUp={(e) => finish(e)}
                  onPointerCancel={(e) => finish(e, true)}
                  onKeyDown={(e) => onKey(e, p)}
                  onDoubleClick={() => onOpen?.(p.id)}
                  className={`focus-ring group absolute z-20 flex items-center overflow-hidden rounded-lg text-xs font-semibold text-white shadow-sm ${BAR_TONE[p.status]} ${isCritical ? 'ring-2 ring-danger-500 ring-offset-1 ring-offset-bg-secondary' : ''} ${selectedId === p.id ? 'outline outline-2 outline-offset-2 outline-accent' : ''} ${moving.has(p.id) ? 'opacity-80' : ''} ${fixed || readOnly ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'} ${drag?.id === p.id ? 'transition-none' : 'transition-[left,width] duration-150'}`}
                  style={{ left: g.left, width: Math.max(g.width, 6), top: top + 8, height: ROW_H - 18, touchAction: 'pan-x pan-y' }}
                >
                  <div className="absolute inset-y-0 left-0 bg-black/25" style={{ width: `${pct}%` }} aria-hidden="true" />
                  <span className="relative truncate px-2">{g.width > 90 ? p.name : ''}</span>
                  {p.locked && <Lock size={11} className="relative mr-1.5 ml-auto shrink-0" aria-hidden="true" />}
                  {!fixed && !readOnly && (
                    <>
                      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/30" onPointerDown={(e) => begin(e, p, 'start')} onPointerMove={track} onPointerUp={(e) => finish(e)} onPointerCancel={(e) => finish(e, true)} />
                      <span aria-hidden="true" className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/30" onPointerDown={(e) => begin(e, p, 'end')} onPointerMove={track} onPointerUp={(e) => finish(e)} onPointerCancel={(e) => finish(e, true)} />
                    </>
                  )}
                </div>
              </div>
            );
          })}

          {/* Milestones & linked jobs */}
          {markers.map((m) => {
            const row = rowOf.get(m.phaseId);
            if (row === undefined) return null;
            return <div key={m.id} title={m.label} aria-hidden="true" className={`pointer-events-auto absolute z-30 h-2.5 w-2.5 rotate-45 border border-bg-secondary ${MARKER_TONE[m.tone]}`} style={{ left: xForDate(range, m.date, px) + px / 2 - 5, top: HEADER_H + row * ROW_H + ROW_H - 12 }} />;
          })}
        </div>
      </div>
    </div>
  );
}
