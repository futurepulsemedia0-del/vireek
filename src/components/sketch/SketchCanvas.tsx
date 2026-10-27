/**
 * Touch-first sketch canvas. Pointer events + SVG in screen space.
 * One finger: tool action (draw tools: press to aim, release to place) or pan (select/pan tool).
 * Two fingers: pinch-zoom and pan. Mouse wheel: zoom.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addDimension, addNote, addOpening, addRoom, addWall, allVertices, dist, docTotals, formatArea, formatLength, handlesFor,
  hitTest, moveNote, moveOpening, moveVertex, openingCenter, polygonArea, polygonCentroid, projectOnSegment,
  samePt, snapPoint, boundsOf, wallLength, MM_PER_FOOT, type Pt, type SketchDoc, type SketchSelection,
} from '@/lib/siteSketch';

export type SketchTool = 'select' | 'pan' | 'wall' | 'room' | 'dimension' | 'door' | 'window' | 'note';

interface View { cx: number; cy: number; ppm: number }
interface Size { w: number; h: number }

const MIN_PPM = 0.01;
const MAX_PPM = 2;
const HANDLE_HIT_PX = 22;
const SNAP_PX = 16;
const TAP_SLOP_PX = 8;

const C = {
  text: 'rgb(var(--text-primary))',
  muted: 'rgb(var(--text-secondary))',
  border: 'rgb(var(--border-default))',
  bg: 'rgb(var(--bg-primary))',
  accent: 'rgb(var(--accent-primary))',
  danger: 'rgb(var(--danger))',
};

const clampPpm = (n: number) => Math.min(MAX_PPM, Math.max(MIN_PPM, n));

function gridStep(unit: 'imperial' | 'metric', ppm: number): number {
  const steps = unit === 'imperial' ? [152.4, 304.8, 609.6, 1524, 3048, 15240, 30480] : [100, 250, 500, 1000, 5000, 10000, 50000];
  return steps.find((s) => s * ppm >= 22) ?? steps[steps.length - 1];
}

function fitView(doc: SketchDoc, size: Size): View {
  const b = boundsOf(doc);
  if (!b) return { cx: 0, cy: 0, ppm: clampPpm(size.w / (doc.unit === 'imperial' ? 26 * MM_PER_FOOT : 8000)) };
  const w = Math.max(b.maxX - b.minX, 1000);
  const h = Math.max(b.maxY - b.minY, 1000);
  const ppm = clampPpm(Math.min((size.w * 0.84) / w, (size.h * 0.78) / h));
  return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, ppm };
}

interface Props {
  doc: SketchDoc;
  tool: SketchTool;
  selection: SketchSelection;
  gridSnap: boolean;
  ortho: boolean;
  showLengths: boolean;
  readOnly?: boolean;
  fitSignal: number;
  onSelect: (sel: SketchSelection) => void;
  onPreview: (doc: SketchDoc | null) => void;
  onCommit: (doc: SketchDoc, nextSelection?: SketchSelection) => void;
  onHint: (message: string) => void;
}

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; startPx: Pt; startView: View; moved: boolean; hit: SketchSelection; tap: boolean }
  | { kind: 'place'; startPx: Pt }
  | { kind: 'drag-vertex'; base: SketchDoc; from: Pt; moved: boolean }
  | { kind: 'drag-note'; base: SketchDoc; id: string; moved: boolean }
  | { kind: 'drag-opening'; base: SketchDoc; id: string; moved: boolean }
  | { kind: 'pinch'; startDist: number; startMid: Pt; startView: View }
  | { kind: 'ignore' };

export function SketchCanvas(props: Props) {
  const { doc, tool, selection, gridSnap, ortho, showLengths, readOnly, fitSignal } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ cx: 0, cy: 0, ppm: 0.1 });
  const [draft, setDraft] = useState<Pt[]>([]);
  const [cursor, setCursor] = useState<{ pt: Pt; kind: string } | null>(null);
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<Gesture>({ kind: 'none' });
  const viewRef = useRef(view);
  const latest = useRef(props);
  const sizeRef = useRef(size);
  viewRef.current = view;
  latest.current = props;
  sizeRef.current = size;

  // ---- size + fit ----
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (size.w === 0 || size.h === 0) return;
    setView(fitView(latest.current.doc, size));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignal, size.w > 0 && size.h > 0]);

  useEffect(() => {
    setDraft([]);
    setCursor(null);
  }, [tool]);

  // ---- coordinate helpers ----
  const toWorld = useCallback((px: Pt, v: View = viewRef.current): Pt => {
    const s = sizeRef.current;
    return { x: v.cx + (px.x - s.w / 2) / v.ppm, y: v.cy + (px.y - s.h / 2) / v.ppm };
  }, []);
  const S = useCallback(
    (p: Pt): Pt => ({ x: (p.x - view.cx) * view.ppm + size.w / 2, y: (p.y - view.cy) * view.ppm + size.h / 2 }),
    [view, size],
  );
  const localPx = (e: { clientX: number; clientY: number }): Pt => {
    const r = svgRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const step = gridStep(doc.unit, view.ppm);
  const snapAt = useCallback(
    (world: Pt, anchor: Pt | null, extra: Pt[] = []) => {
      const p = latest.current;
      return snapPoint(world, {
        gridMm: p.gridSnap ? gridStep(p.doc.unit, viewRef.current.ppm) : 0,
        vertices: [...allVertices(p.doc), ...extra],
        radiusMm: SNAP_PX / viewRef.current.ppm,
        anchor,
        ortho: p.ortho,
      });
    },
    [],
  );

  const snapDrag = useCallback((world: Pt, base: SketchDoc, from: Pt) => {
    const p = latest.current;
    return snapPoint(world, {
      gridMm: p.gridSnap ? gridStep(base.unit, viewRef.current.ppm) : 0,
      vertices: allVertices(base).filter((v) => !samePt(v, from)),
      radiusMm: SNAP_PX / viewRef.current.ppm,
      anchor: null,
      ortho: false,
    }).pt;
  }, []);

  // ---- wheel zoom (non-passive) ----
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = { x: e.clientX - r.left, y: e.clientY - r.top };
      const v = viewRef.current;
      const before = toWorld(px, v);
      const ppm = clampPpm(v.ppm * Math.exp(-e.deltaY * 0.0015));
      const s = sizeRef.current;
      setView({ ppm, cx: before.x - (px.x - s.w / 2) / ppm, cy: before.y - (px.y - s.h / 2) / ppm });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [toWorld]);

  // ---- draft actions ----
  const finishDraft = useCallback(() => {
    const p = latest.current;
    if (p.tool === 'room') {
      if (draft.length >= 3) {
        const res = addRoom(p.doc, draft);
        if (res.id) p.onCommit(res.doc, { kind: 'room', id: res.id });
        else p.onHint('That shape is too small to be a room.');
      } else p.onHint('Tap at least 3 corners, then close the room.');
    }
    setDraft([]);
    setCursor(null);
  }, [draft]);

  const cancelDraft = useCallback(() => {
    setDraft([]);
    setCursor(null);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') cancelDraft();
    else if (e.key === 'Enter') finishDraft();
  };

  // ---- placement ----
  const place = (worldRaw: Pt) => {
    const p = latest.current;
    if (p.readOnly) return;
    const d = p.doc;
    if (p.tool === 'wall') {
      const anchor = draft[draft.length - 1] ?? null;
      const sp = snapAt(worldRaw, anchor, draft).pt;
      if (!anchor) return setDraft([sp]);
      if (dist(anchor, sp) < 10) {
        setDraft([]); // tapped the same spot again = finish the chain
        return;
      }
      const next = addWall(d, anchor, sp);
      if (next === d) p.onHint('That wall is too short or already exists.');
      else p.onCommit(next);
      setDraft(samePt(sp, draft[0]) && draft.length > 1 ? [] : [sp]);
    } else if (p.tool === 'room') {
      const sp = snapAt(worldRaw, draft[draft.length - 1] ?? null, draft).pt;
      if (draft.length >= 3 && samePt(sp, draft[0])) return finishDraft();
      if (draft.length && samePt(sp, draft[draft.length - 1])) return;
      setDraft([...draft, sp]);
    } else if (p.tool === 'dimension') {
      const sp = snapAt(worldRaw, draft[0] ?? null, draft).pt;
      if (!draft.length) return setDraft([sp]);
      const next = addDimension(d, draft[0], sp);
      if (next === d) p.onHint('Pick two different points to measure between.');
      else p.onCommit(next);
      setDraft([]);
    } else if (p.tool === 'door' || p.tool === 'window') {
      const tolMm = (HANDLE_HIT_PX * 1.6) / viewRef.current.ppm;
      let best: { id: string; t: number; d: number } | null = null;
      for (const w of d.walls) {
        const pr = projectOnSegment(worldRaw, w.a, w.b);
        if (pr.d <= tolMm && (!best || pr.d < best.d)) best = { id: w.id, t: pr.t, d: pr.d };
      }
      if (!best) return p.onHint(`Tap a wall to place the ${p.tool}.`);
      const res = addOpening(d, best.id, best.t, p.tool);
      if (!res.id) return p.onHint('That wall is too short for an opening.');
      p.onCommit(res.doc, { kind: 'opening', id: res.id });
    } else if (p.tool === 'note') {
      const res = addNote(d, snapAt(worldRaw, null).pt);
      if (res.id) p.onCommit(res.doc, { kind: 'note', id: res.id });
    }
  };

  // ---- pointer handling ----
  const onPointerDown = (e: React.PointerEvent) => {
    wrapRef.current?.focus({ preventScroll: true });
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* not supported in this environment */
    }
    const px = localPx(e);
    pointers.current.set(e.pointerId, px);
    const p = latest.current;

    if (pointers.current.size === 2) {
      if (gesture.current.kind === 'drag-vertex' || gesture.current.kind === 'drag-note' || gesture.current.kind === 'drag-opening') p.onPreview(null);
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: 'pinch', startDist: Math.max(1, dist(a, b)), startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, startView: viewRef.current };
      return;
    }
    if (pointers.current.size > 2) {
      gesture.current = { kind: 'ignore' };
      return;
    }

    if (p.tool === 'pan' || e.button === 1 || p.readOnly) {
      gesture.current = { kind: 'pan', startPx: px, startView: viewRef.current, moved: false, hit: null, tap: false };
      return;
    }
    if (p.tool === 'select') {
      const world = toWorld(px);
      // grab a handle of the selected element first
      const handles = handlesFor(p.doc, p.selection);
      const hi = handles.findIndex((h) => {
        const s = { x: (h.x - viewRef.current.cx) * viewRef.current.ppm + sizeRef.current.w / 2, y: (h.y - viewRef.current.cy) * viewRef.current.ppm + sizeRef.current.h / 2 };
        return dist(s, px) <= HANDLE_HIT_PX;
      });
      if (hi >= 0 && p.selection) {
        if (p.selection.kind === 'note') return void (gesture.current = { kind: 'drag-note', base: p.doc, id: p.selection.id, moved: false });
        if (p.selection.kind === 'opening') return void (gesture.current = { kind: 'drag-opening', base: p.doc, id: p.selection.id, moved: false });
        return void (gesture.current = { kind: 'drag-vertex', base: p.doc, from: handles[hi], moved: false });
      }
      const hit = hitTest(p.doc, world, HANDLE_HIT_PX / viewRef.current.ppm);
      gesture.current = { kind: 'pan', startPx: px, startView: viewRef.current, moved: false, hit, tap: true };
      return;
    }
    // draw / place tools
    gesture.current = { kind: 'place', startPx: px };
    const world = toWorld(px);
    setCursor(snapAt(world, p.tool === 'wall' || p.tool === 'room' ? draft[draft.length - 1] ?? null : p.tool === 'dimension' ? draft[0] ?? null : null, draft));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const px = localPx(e);
    const had = pointers.current.has(e.pointerId);
    if (had) pointers.current.set(e.pointerId, px);
    const g = gesture.current;
    const p = latest.current;

    if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const ppm = clampPpm((g.startView.ppm * dist(a, b)) / g.startDist);
      const anchorWorld = toWorld(g.startMid, g.startView);
      const s = sizeRef.current;
      setView({ ppm, cx: anchorWorld.x - (mid.x - s.w / 2) / ppm, cy: anchorWorld.y - (mid.y - s.h / 2) / ppm });
      return;
    }
    if (g.kind === 'pan' && had) {
      const dx = px.x - g.startPx.x;
      const dy = px.y - g.startPx.y;
      if (!g.moved && Math.hypot(dx, dy) < TAP_SLOP_PX) return;
      g.moved = true;
      setView({ ...g.startView, cx: g.startView.cx - dx / g.startView.ppm, cy: g.startView.cy - dy / g.startView.ppm });
      return;
    }
    if (g.kind === 'drag-vertex' && had) {
      g.moved = true;
      const sp = snapDrag(toWorld(px), g.base, g.from);
      p.onPreview(moveVertex(g.base, g.from, sp));
      setCursor({ pt: sp, kind: 'drag' });
      return;
    }
    if (g.kind === 'drag-note' && had) {
      g.moved = true;
      p.onPreview(moveNote(g.base, g.id, snapAt(toWorld(px), null).pt));
      return;
    }
    if (g.kind === 'drag-opening' && had) {
      g.moved = true;
      p.onPreview(moveOpening(g.base, g.id, toWorld(px)));
      return;
    }
    // hover / aim (mouse hover, or finger held down on a draw tool)
    const drawing = p.tool === 'wall' || p.tool === 'room' || p.tool === 'dimension';
    if (drawing && (g.kind === 'place' || e.pointerType === 'mouse')) {
      const anchor = p.tool === 'dimension' ? draft[0] ?? null : draft[draft.length - 1] ?? null;
      setCursor(snapAt(toWorld(px), anchor, draft));
    }
  };

  const endPointer = (e: React.PointerEvent, cancelled: boolean) => {
    const px = localPx(e);
    const had = pointers.current.delete(e.pointerId);
    const g = gesture.current;
    const p = latest.current;
    if (!had) return;

    if (g.kind === 'pinch') {
      gesture.current = pointers.current.size === 0 ? { kind: 'none' } : { kind: 'ignore' };
      return;
    }
    if (g.kind === 'ignore') {
      if (pointers.current.size === 0) gesture.current = { kind: 'none' };
      return;
    }
    gesture.current = { kind: 'none' };
    if (cancelled) {
      p.onPreview(null);
      return;
    }
    if (g.kind === 'pan' && g.tap && !g.moved) p.onSelect(g.hit);
    else if (g.kind === 'place') place(toWorld(px));
    else if (g.kind === 'drag-vertex') {
      if (g.moved) {
        const sp = snapDrag(toWorld(px), g.base, g.from);
        p.onCommit(moveVertex(g.base, g.from, sp));
      }
      p.onPreview(null);
      setCursor(null);
    } else if (g.kind === 'drag-note') {
      if (g.moved) p.onCommit(moveNote(g.base, g.id, snapAt(toWorld(px), null).pt));
      p.onPreview(null);
    } else if (g.kind === 'drag-opening') {
      if (g.moved) p.onCommit(moveOpening(g.base, g.id, toWorld(px)));
      p.onPreview(null);
    }
    if (e.pointerType !== 'mouse') setCursor(null);
  };

  // ---- derived render data ----
  const totals = useMemo(() => docTotals(doc), [doc]);
  const gridPaths = useMemo(() => {
    if (size.w === 0) return { v: '', h: '' };
    const min = toWorld({ x: 0, y: 0 });
    const max = toWorld({ x: size.w, y: size.h });
    const count = ((max.x - min.x) / step + (max.y - min.y) / step) | 0;
    if (count > 400) return { v: '', h: '' };
    let v = '';
    let h = '';
    for (let x = Math.ceil(min.x / step) * step; x <= max.x; x += step) {
      const sx = ((x - view.cx) * view.ppm + size.w / 2).toFixed(1);
      v += `M${sx} 0V${size.h}`;
    }
    for (let y = Math.ceil(min.y / step) * step; y <= max.y; y += step) {
      const sy = ((y - view.cy) * view.ppm + size.h / 2).toFixed(1);
      h += `M0 ${sy}H${size.w}`;
    }
    return { v, h };
  }, [view, size, step, toWorld]);

  const unit = doc.unit;
  const label = (mm: number) => formatLength(mm, unit);
  const isSel = (kind: string, id: string) => selection?.kind === kind && selection.id === id;
  const handles = readOnly ? [] : handlesFor(doc, selection);
  const drawing = tool === 'wall' || tool === 'room' || tool === 'dimension';
  const anchor = tool === 'dimension' ? draft[0] ?? null : draft[draft.length - 1] ?? null;

  const textProps = { textAnchor: 'middle' as const, fontSize: 12, fontWeight: 600, fill: C.text, stroke: C.bg, strokeWidth: 3.5, paintOrder: 'stroke' as const, style: { pointerEvents: 'none' as const, userSelect: 'none' as const } };

  const segLabel = (a: Pt, b: Pt, text: string, key: string, color = C.text) => {
    const sa = S(a);
    const sb = S(b);
    if (dist(sa, sb) < 56) return null;
    let ang = (Math.atan2(sb.y - sa.y, sb.x - sa.x) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    const mx = (sa.x + sb.x) / 2;
    const my = (sa.y + sb.y) / 2;
    return (
      <text key={key} {...textProps} fill={color} transform={`translate(${mx} ${my}) rotate(${ang}) translate(0 -9)`}>
        {text}
      </text>
    );
  };

  const cursorLabel = drawing && cursor && anchor ? label(dist(anchor, cursor.pt)) : null;
  const draftPoly = tool === 'room' && draft.length >= 2 ? draft.map((q) => `${S(q).x},${S(q).y}`).join(' ') : null;

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative h-full w-full overflow-hidden rounded-2xl border border-border bg-bg-primary outline-none focus-visible:ring-2 focus-visible:ring-accent"
      role="application"
      aria-label={`Sketch canvas. ${totals.roomCount} rooms, ${formatArea(totals.floorAreaMm2, unit)} total floor area, ${doc.walls.length} walls.`}
    >
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        className="block touch-none select-none"
        style={{ touchAction: 'none', cursor: tool === 'pan' ? 'grab' : drawing || tool === 'door' || tool === 'window' || tool === 'note' ? 'crosshair' : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endPointer(e, false)}
        onPointerCancel={(e) => endPointer(e, true)}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse' && gesture.current.kind === 'none') setCursor(null);
        }}
      >
        <title>Site sketch</title>
        <path d={gridPaths.v + gridPaths.h} stroke={C.border} strokeWidth={1} fill="none" opacity={0.7} />

        {doc.rooms.map((r) => {
          const c = S(polygonCentroid(r.points));
          const area = polygonArea(r.points);
          const sel = isSel('room', r.id);
          return (
            <g key={r.id}>
              <polygon
                points={r.points.map((q) => `${S(q).x},${S(q).y}`).join(' ')}
                fill={C.accent}
                fillOpacity={sel ? 0.18 : 0.08}
                stroke={sel ? C.accent : 'none'}
                strokeDasharray="6 4"
                strokeWidth={2}
              />
              <text {...textProps} x={c.x} y={c.y - 2} fontSize={13}>{r.name}</text>
              <text {...textProps} x={c.x} y={c.y + 14} fontWeight={500} fill={C.muted}>{formatArea(area, unit)}</text>
            </g>
          );
        })}

        {doc.walls.map((w) => {
          const a = S(w.a);
          const b = S(w.b);
          const sel = isSel('wall', w.id);
          return (
            <g key={w.id}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={sel ? C.accent : C.text} strokeWidth={Math.min(12, Math.max(4, 100 * view.ppm))} strokeLinecap="square" />
              {(showLengths || sel) && segLabel(w.a, w.b, label(wallLength(w)), `wl-${w.id}`, sel ? C.accent : C.text)}
            </g>
          );
        })}

        {doc.openings.map((o) => {
          const w = doc.walls.find((x) => x.id === o.wall_id);
          const cMm = openingCenter(doc, o);
          if (!w || !cMm) return null;
          const len = Math.max(1, wallLength(w));
          const ux = (w.b.x - w.a.x) / len;
          const uy = (w.b.y - w.a.y) / len;
          const half = o.width_mm / 2;
          const p1 = S({ x: cMm.x - ux * half, y: cMm.y - uy * half });
          const p2 = S({ x: cMm.x + ux * half, y: cMm.y + uy * half });
          const sel = isSel('opening', o.id);
          const col = sel ? C.accent : o.kind === 'door' ? C.muted : C.accent;
          const wPx = dist(p1, p2);
          const nx = -(p2.y - p1.y) / Math.max(1, wPx);
          const ny = (p2.x - p1.x) / Math.max(1, wPx);
          return (
            <g key={o.id}>
              <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={C.bg} strokeWidth={Math.min(12, Math.max(4, 100 * view.ppm)) + 2} />
              {o.kind === 'door' ? (
                <>
                  <line x1={p1.x} y1={p1.y} x2={p1.x + nx * wPx} y2={p1.y + ny * wPx} stroke={col} strokeWidth={2} />
                  <path d={`M${p2.x} ${p2.y} A${wPx} ${wPx} 0 0 0 ${p1.x + nx * wPx} ${p1.y + ny * wPx}`} fill="none" stroke={col} strokeWidth={1.5} strokeDasharray="3 3" />
                </>
              ) : (
                <>
                  <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={col} strokeWidth={5} />
                  <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={C.bg} strokeWidth={2} />
                </>
              )}
            </g>
          );
        })}

        {doc.dimensions.map((d) => {
          const a = S(d.a);
          const b = S(d.b);
          const sel = isSel('dimension', d.id);
          const col = sel ? C.accent : C.danger;
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          const tx = Math.sin(ang) * 6;
          const ty = -Math.cos(ang) * 6;
          return (
            <g key={d.id}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={col} strokeWidth={2} />
              <line x1={a.x - tx} y1={a.y - ty} x2={a.x + tx} y2={a.y + ty} stroke={col} strokeWidth={2} />
              <line x1={b.x - tx} y1={b.y - ty} x2={b.x + tx} y2={b.y + ty} stroke={col} strokeWidth={2} />
              {segLabel(d.a, d.b, label(dist(d.a, d.b)), `dl-${d.id}`, col) ?? (
                <text key={`dl-${d.id}`} {...textProps} fill={col} x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 9}>{label(dist(d.a, d.b))}</text>
              )}
            </g>
          );
        })}

        {doc.notes.map((n) => {
          const s = S(n.at);
          const sel = isSel('note', n.id);
          return (
            <g key={n.id}>
              <circle cx={s.x} cy={s.y} r={5} fill={sel ? C.accent : C.muted} />
              <text {...textProps} x={s.x} y={s.y - 10} fill={sel ? C.accent : C.text}>{n.text || 'Note'}</text>
            </g>
          );
        })}

        {draftPoly && <polyline points={draftPoly} fill="none" stroke={C.accent} strokeWidth={2} strokeDasharray="6 4" />}
        {drawing && cursor && anchor && (
          <line x1={S(anchor).x} y1={S(anchor).y} x2={S(cursor.pt).x} y2={S(cursor.pt).y} stroke={C.accent} strokeWidth={2} strokeDasharray="6 4" />
        )}
        {draft.map((q, i) => (
          <circle key={i} cx={S(q).x} cy={S(q).y} r={5} fill={C.accent} />
        ))}
        {cursor && (drawing || cursor.kind === 'drag') && (
          <g style={{ pointerEvents: 'none' }}>
            <circle cx={S(cursor.pt).x} cy={S(cursor.pt).y} r={cursor.kind === 'vertex' ? 11 : 7} fill="none" stroke={C.accent} strokeWidth={2} />
            <line x1={S(cursor.pt).x - 14} y1={S(cursor.pt).y} x2={S(cursor.pt).x + 14} y2={S(cursor.pt).y} stroke={C.accent} strokeWidth={1} />
            <line x1={S(cursor.pt).x} y1={S(cursor.pt).y - 14} x2={S(cursor.pt).x} y2={S(cursor.pt).y + 14} stroke={C.accent} strokeWidth={1} />
            {cursorLabel && (
              <text {...textProps} x={S(cursor.pt).x} y={S(cursor.pt).y - 22} fill={C.accent}>{cursorLabel}</text>
            )}
          </g>
        )}
        {handles.map((h, i) => (
          <circle key={i} cx={S(h).x} cy={S(h).y} r={9} fill={C.bg} stroke={C.accent} strokeWidth={3} style={{ pointerEvents: 'none' }} />
        ))}
      </svg>

      {draft.length > 0 && !readOnly && (
        <div className="absolute inset-x-0 bottom-3 flex justify-center gap-2">
          {tool === 'room' && (
            <button type="button" onClick={finishDraft} disabled={draft.length < 3} className="focus-ring rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white shadow-lg disabled:opacity-50">
              Close room
            </button>
          )}
          {tool === 'wall' && (
            <button type="button" onClick={cancelDraft} className="focus-ring rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white shadow-lg">
              Finish walls
            </button>
          )}
          <button type="button" onClick={cancelDraft} className="focus-ring rounded-full border border-border bg-bg-secondary px-4 py-2 text-sm font-semibold text-text-primary shadow-lg">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
