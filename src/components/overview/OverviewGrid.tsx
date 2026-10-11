import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { EyeOff, GripVertical, MoveDiagonal2 } from 'lucide-react';
import {
  GRID_COLUMNS,
  MAX_ROW_UNITS,
  ROW_UNIT_PX,
  WIDGETS,
  type LayoutItem,
  type OverviewWidgetId,
} from '@/lib/overviewLayout';

const GAP_PX = 20; // matches Tailwind gap-5
type Breakpoint = 'sm' | 'md' | 'lg';

function currentBreakpoint(): Breakpoint {
  if (typeof window === 'undefined' || !window.matchMedia) return 'lg';
  if (window.matchMedia('(min-width: 1024px)').matches) return 'lg';
  if (window.matchMedia('(min-width: 640px)').matches) return 'md';
  return 'sm';
}

function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(currentBreakpoint);
  useEffect(() => {
    if (!window.matchMedia) return;
    const update = () => setBp(currentBreakpoint());
    const queries = [window.matchMedia('(min-width: 1024px)'), window.matchMedia('(min-width: 640px)')];
    queries.forEach((q) => q.addEventListener('change', update));
    return () => queries.forEach((q) => q.removeEventListener('change', update));
  }, []);
  return bp;
}

/** Desktop honours the saved span; tablets use half/full; phones always full width. */
function spanFor(w: number, bp: Breakpoint): number {
  if (bp === 'lg') return w;
  if (bp === 'md') return w >= 6 ? GRID_COLUMNS : 6;
  return GRID_COLUMNS;
}

interface OverviewGridProps {
  items: LayoutItem[];
  editing: boolean;
  loading?: boolean;
  renderWidget: (id: OverviewWidgetId) => ReactNode;
  onMove: (id: OverviewWidgetId, targetId: OverviewWidgetId) => void;
  onMoveBy: (id: OverviewWidgetId, delta: -1 | 1) => void;
  onResize: (id: OverviewWidgetId, size: { w?: number; h?: number }) => void;
  onHide: (id: OverviewWidgetId) => void;
}

interface ResizeSession {
  id: OverviewWidgetId;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  startPx: number;
  colPx: number;
}

export function OverviewGrid({ items, editing, loading, renderWidget, onMove, onMoveBy, onResize, onHide }: OverviewGridProps) {
  const bp = useBreakpoint();
  const gridRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<OverviewWidgetId | null>(null);
  const lastSwapRef = useRef(0);
  const resizeRef = useRef<ResizeSession | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const announce = useCallback((msg: string) => setAnnouncement(msg), []);

  // ---- drag to reorder (pointer events: mouse, touch and pen) ----
  const onDragStart = (e: PointerEvent<HTMLButtonElement>, id: OverviewWidgetId) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragId(id);
  };

  const onDragMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!dragId) return;
    if (e.clientY < 80) window.scrollBy(0, -18);
    else if (e.clientY > window.innerHeight - 80) window.scrollBy(0, 18);
    const now = Date.now();
    if (now - lastSwapRef.current < 150) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-overview-widget]');
    const targetId = el?.dataset.overviewWidget as OverviewWidgetId | undefined;
    if (targetId && targetId !== dragId) {
      lastSwapRef.current = now;
      onMove(dragId, targetId);
    }
  };

  const onDragEnd = () => setDragId(null);

  const onHandleKey = (e: KeyboardEvent<HTMLButtonElement>, id: OverviewWidgetId) => {
    const delta = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : 0;
    if (!delta) return;
    e.preventDefault();
    onMoveBy(id, delta);
    announce(`${WIDGETS[id].title} moved ${delta < 0 ? 'earlier' : 'later'}.`);
  };

  // ---- resize (snaps to columns horizontally, row units vertically) ----
  const onResizeStart = (e: PointerEvent<HTMLButtonElement>, item: LayoutItem) => {
    if (e.button !== 0 || !gridRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const cell = e.currentTarget.closest<HTMLElement>('[data-overview-widget]');
    resizeRef.current = {
      id: item.id,
      startX: e.clientX,
      startY: e.clientY,
      startW: item.w,
      startH: item.h,
      startPx: cell?.getBoundingClientRect().height ?? ROW_UNIT_PX * 2,
      colPx: (gridRef.current.getBoundingClientRect().width + GAP_PX) / GRID_COLUMNS,
    };
  };

  const onResizeMove = (e: PointerEvent<HTMLButtonElement>) => {
    const s = resizeRef.current;
    if (!s) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    const w = Math.round(s.startW + dx / s.colPx);
    // Height stays "auto" until the user actually drags vertically.
    const touchedHeight = s.startH > 0 || Math.abs(dy) > 12;
    const h = touchedHeight ? Math.min(MAX_ROW_UNITS, Math.max(1, Math.round((s.startPx + dy) / ROW_UNIT_PX))) : undefined;
    onResize(s.id, { w, h });
  };

  const onResizeEnd = () => {
    resizeRef.current = null;
  };

  const onResizeKey = (e: KeyboardEvent<HTMLButtonElement>, item: LayoutItem) => {
    const cell = e.currentTarget.closest<HTMLElement>('[data-overview-widget]');
    const baseH = item.h > 0 ? item.h : Math.max(1, Math.round((cell?.getBoundingClientRect().height ?? ROW_UNIT_PX * 2) / ROW_UNIT_PX));
    if (e.key === 'ArrowLeft') onResize(item.id, { w: item.w - 1 });
    else if (e.key === 'ArrowRight') onResize(item.id, { w: item.w + 1 });
    else if (e.key === 'ArrowUp') onResize(item.id, { h: baseH - 1 });
    else if (e.key === 'ArrowDown') onResize(item.id, { h: baseH + 1 });
    else return;
    e.preventDefault();
    announce(`Resized ${WIDGETS[item.id].title}.`);
  };

  if (loading) {
    return (
      <div className="grid grid-cols-12 gap-5" aria-busy="true">
        {[3, 3, 3, 3, 6, 6].map((w, i) => (
          <div
            key={i}
            style={{ gridColumn: `span ${spanFor(w, bp)} / span ${spanFor(w, bp)}` }}
            className="h-36 animate-pulse rounded-2xl bg-bg-tertiary"
          />
        ))}
      </div>
    );
  }

  return (
    <>
      <div ref={gridRef} className="grid grid-cols-12 gap-5" data-testid="overview-grid">
        {items.map((item) => {
          const node = renderWidget(item.id);
          if (!node && !editing) return null;
          const span = spanFor(item.w, bp);
          const title = WIDGETS[item.id].title;
          return (
            <div
              key={item.id}
              data-overview-widget={item.id}
              style={{
                gridColumn: `span ${span} / span ${span}`,
                height: item.h > 0 ? item.h * ROW_UNIT_PX : undefined,
              }}
              className={`relative min-w-0 ${
                editing ? 'rounded-2xl outline-dashed outline-2 outline-offset-2 outline-accent/40' : ''
              } ${dragId === item.id ? 'z-10 opacity-60 outline-accent' : ''}`}
            >
              <div
                className={`h-full ${item.h > 0 ? 'overflow-auto' : ''} [&>*]:h-full ${
                  editing ? 'pointer-events-none select-none' : ''
                }`}
                {...(editing ? ({ inert: '' } as object) : {})}
              >
                {node ?? (
                  <div className="flex h-full min-h-[96px] items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 p-4 text-center text-sm text-text-secondary">
                    {title} appears here once there is data to show.
                  </div>
                )}
              </div>

              {editing && (
                <>
                  <div className="absolute inset-x-2 top-2 z-20 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      aria-label={`Move ${title}. Drag, or use the arrow keys.`}
                      onPointerDown={(e) => onDragStart(e, item.id)}
                      onPointerMove={onDragMove}
                      onPointerUp={onDragEnd}
                      onPointerCancel={onDragEnd}
                      onKeyDown={(e) => onHandleKey(e, item.id)}
                      className="focus-ring flex min-h-[32px] cursor-grab touch-none items-center gap-1 rounded-lg border border-border bg-bg-secondary/95 px-2 py-1 text-xs font-medium text-text-primary shadow-sm active:cursor-grabbing"
                    >
                      <GripVertical size={14} aria-hidden="true" />
                      {title}
                    </button>
                    <button
                      type="button"
                      aria-label={`Hide ${title}`}
                      onClick={() => {
                        onHide(item.id);
                        announce(`${title} hidden.`);
                      }}
                      className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-bg-secondary/95 text-text-secondary shadow-sm hover:text-text-primary"
                    >
                      <EyeOff size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <button
                    type="button"
                    aria-label={`Resize ${title}. Drag, or use the arrow keys.`}
                    onPointerDown={(e) => onResizeStart(e, item)}
                    onPointerMove={onResizeMove}
                    onPointerUp={onResizeEnd}
                    onPointerCancel={onResizeEnd}
                    onKeyDown={(e) => onResizeKey(e, item)}
                    className="focus-ring absolute bottom-2 right-2 z-20 flex h-8 w-8 cursor-nwse-resize touch-none items-center justify-center rounded-lg border border-border bg-bg-secondary/95 text-text-secondary shadow-sm hover:text-text-primary"
                  >
                    <MoveDiagonal2 size={14} aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </>
  );
}
