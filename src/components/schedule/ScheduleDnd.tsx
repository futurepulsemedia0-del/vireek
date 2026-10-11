import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { GripVertical, ArrowRightLeft, Loader2 } from 'lucide-react';
import {
  dragId,
  dropId,
  parseDragId,
  parseDropId,
  type DropTarget,
  type MoveCheck,
  type MovePlan,
  type MoveTargetOption,
} from '@/lib/scheduleDnd';

// ============================================================
// Drag-and-drop primitives shared by Calendar, Dispatch Board and Jobs Kanban.
//   <ScheduleDndProvider>  sensors (mouse / touch long-press / keyboard), overlay, announcements
//   <DraggableJob>         wraps a card: drag from anywhere, plus a focusable handle + "Move to…" menu
//   <DropZone>             a day / lane / technician / status / unscheduled target with live validity preview
// The "Move to…" menu is the non-drag alternative (WCAG 2.5.7) for keyboard, switch and screen-reader users.
// ============================================================

interface ScheduleDndContextValue {
  activeJobId: string | null;
  plan: (jobId: string, target: DropTarget) => MovePlan | null;
  previewFor: (target: DropTarget) => MoveCheck | null;
  onMove: (jobId: string, target: DropTarget) => void;
}

const ScheduleDndCtx = createContext<ScheduleDndContextValue | null>(null);

function useScheduleDnd(): ScheduleDndContextValue {
  const ctx = useContext(ScheduleDndCtx);
  if (!ctx) throw new Error('Schedule drag-and-drop components must be used inside <ScheduleDndProvider>');
  return ctx;
}

// Mouse/touch: the zone under the pointer. Keyboard (no pointer): nearest centre.
const collisionDetection: CollisionDetection = (args) => {
  if (args.pointerCoordinates) return pointerWithin(args);
  return closestCenter(args);
};

// Arrow keys jump to the nearest drop zone in that direction (instead of nudging 25px).
const ARROWS: Record<string, [number, number]> = {
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowDown: [0, 1],
  ArrowUp: [0, -1],
};

const keyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const dir = ARROWS[event.code];
  const { active, droppableRects, droppableContainers, collisionRect } = context;
  if (!dir || !active || !collisionRect) return undefined;
  event.preventDefault();

  const cx = collisionRect.left + collisionRect.width / 2;
  const cy = collisionRect.top + collisionRect.height / 2;
  let best: { x: number; y: number } | null = null;
  let bestScore = Infinity;

  droppableContainers.getEnabled().forEach((container) => {
    const r = droppableRects.get(container.id);
    if (!r) return;
    const tx = r.left + r.width / 2;
    const ty = r.top + r.height / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    const along = dx * dir[0] + dy * dir[1];
    if (along <= 8) return; // only zones ahead of us
    const across = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]);
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = { x: tx - collisionRect.width / 2, y: ty - collisionRect.height / 2 };
    }
  });

  return best ?? undefined;
};

export function ScheduleDndProvider({
  children,
  plan,
  onMove,
  describeJob,
  renderOverlay,
}: {
  children: ReactNode;
  plan: (jobId: string, target: DropTarget) => MovePlan | null;
  onMove: (jobId: string, target: DropTarget) => void | Promise<unknown>;
  /** Short spoken label, e.g. "Jane Doe, plumbing". */
  describeJob: (jobId: string) => string;
  renderOverlay: (jobId: string) => ReactNode;
}) {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  );

  const previewFor = useCallback(
    (target: DropTarget) => (activeJobId ? plan(activeJobId, target)?.check ?? null : null),
    [activeJobId, plan],
  );

  const handleMove = useCallback(
    (jobId: string, target: DropTarget) => {
      void onMove(jobId, target);
    },
    [onMove],
  );

  const targetLabel = (over: DragEndEvent['over']): string =>
    (over?.data.current as { label?: string } | undefined)?.label ?? 'this spot';

  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const id = parseDragId(active.id);
      return `Picked up ${id ? describeJob(id) : 'job'}. Use the arrow keys to choose a destination, space to drop, escape to cancel.`;
    },
    onDragOver: ({ active, over }) => {
      const id = parseDragId(active.id);
      const target = parseDropId(over?.id);
      if (!id || !over || !target) return `${id ? describeJob(id) : 'Job'} is not over a drop target.`;
      const p = plan(id, target);
      if (!p) return `Over ${targetLabel(over)} — no change.`;
      return p.check.ok
        ? `Over ${targetLabel(over)}.${p.check.warnings.length ? ` Warning: ${p.check.warnings.join(' ')}` : ''}`
        : `Over ${targetLabel(over)}. Not allowed: ${p.check.reason}`;
    },
    onDragEnd: ({ active, over }) => {
      const id = parseDragId(active.id);
      return over ? `Dropped ${id ? describeJob(id) : 'job'} on ${targetLabel(over)}.` : 'Drop cancelled. The job did not move.';
    },
    onDragCancel: () => 'Move cancelled. The job did not move.',
  };

  const onDragStart = (e: DragStartEvent) => setActiveJobId(parseDragId(e.active.id));

  const onDragEnd = (e: DragEndEvent) => {
    const jobId = parseDragId(e.active.id);
    const target = parseDropId(e.over?.id);
    setActiveJobId(null);
    if (jobId && target) handleMove(jobId, target);
  };

  const value = useMemo<ScheduleDndContextValue>(
    () => ({ activeJobId, plan, previewFor, onMove: handleMove }),
    [activeJobId, plan, previewFor, handleMove],
  );

  return (
    <ScheduleDndCtx.Provider value={value}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveJobId(null)}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              'To pick up this job, press space or enter on its move handle. Use the arrow keys to move between days, technicians or columns, space to drop, escape to cancel. You can also use the Move to menu.',
          },
        }}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {activeJobId ? <div className="cursor-grabbing rounded-xl shadow-2xl ring-2 ring-accent/50">{renderOverlay(activeJobId)}</div> : null}
        </DragOverlay>
      </DndContext>
    </ScheduleDndCtx.Provider>
  );
}

// ------------------------------------------------------------
// Draggable card wrapper
// ------------------------------------------------------------

export function DraggableJob({
  jobId,
  label,
  disabled = false,
  pending = false,
  moveTargets,
  controlsClassName = 'bottom-1.5 right-1.5',
  className = '',
  children,
}: {
  jobId: string;
  /** Accessible name, e.g. "Jane Doe, plumbing". */
  label: string;
  disabled?: boolean;
  /** A save is in flight for this job. */
  pending?: boolean;
  /** When provided, shows the keyboard-accessible "Move to…" menu. */
  moveTargets?: MoveTargetOption[];
  controlsClassName?: string;
  className?: string;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId(jobId),
    disabled: disabled || pending,
  });

  const { onKeyDown, ...pointerListeners } = (listeners ?? {}) as Record<string, unknown>;

  return (
    <div
      ref={setNodeRef}
      {...(pointerListeners as Record<string, never>)}
      className={`group/dj relative select-none [-webkit-touch-callout:none] ${isDragging ? 'opacity-40' : ''} ${pending ? 'opacity-70' : ''} ${className}`}
      aria-busy={pending || undefined}
    >
      {children}
      {pending && (
        <span className={`pointer-events-none absolute ${controlsClassName} text-text-secondary`} aria-hidden="true">
          <Loader2 size={14} className="animate-spin" />
        </span>
      )}
      {!disabled && !pending && (
        <span
          className={`absolute ${controlsClassName} flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/dj:opacity-100 [@media(pointer:coarse)]:opacity-100`}
        >
          <button
            type="button"
            {...attributes}
            onKeyDown={onKeyDown as KeyboardEventHandler<HTMLButtonElement> | undefined}
            aria-label={`Move ${label}. Press space to pick up`}
            className="focus-ring flex h-6 w-6 cursor-grab items-center justify-center rounded-md border border-border bg-bg-secondary text-text-secondary hover:text-text-primary"
          >
            <GripVertical size={13} />
          </button>
          {moveTargets && moveTargets.length > 0 && <MoveJobMenu jobId={jobId} label={label} options={moveTargets} />}
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Drop zone
// ------------------------------------------------------------

export function DropZone({
  target,
  label,
  className = '',
  idleClassName = '',
  children,
}: {
  target: DropTarget;
  /** Spoken name used in announcements, e.g. "Tuesday, Oct 14". */
  label: string;
  className?: string;
  /** Applied when nothing is being dragged. */
  idleClassName?: string;
  children: ReactNode;
}) {
  const { activeJobId, previewFor } = useScheduleDnd();
  const { setNodeRef, isOver } = useDroppable({ id: dropId(target), data: { label } });
  const check = activeJobId ? previewFor(target) : null;

  let state = 'idle';
  if (activeJobId) {
    if (!check) state = isOver ? 'same' : 'available';
    else if (!check.ok) state = 'blocked';
    else state = check.warnings.length ? 'warn' : 'ok';
  }

  const stateClass =
    state === 'idle'
      ? idleClassName
      : isOver
        ? state === 'blocked'
          ? 'border-danger bg-danger/5 ring-2 ring-danger/40'
          : state === 'warn'
            ? 'border-warning-500 bg-warning-500/5 ring-2 ring-warning-500/40'
            : 'border-accent bg-accent/5 ring-2 ring-accent/40'
        : state === 'blocked'
          ? 'opacity-60'
          : 'ring-1 ring-accent/20';

  const hint = isOver && check ? (check.ok ? check.warnings[0] : check.reason) : null;

  return (
    <div ref={setNodeRef} data-drop-state={state} className={`relative transition-colors ${className} ${stateClass}`}>
      {children}
      {hint && (
        <p
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-2 bottom-2 z-10 rounded-lg px-2 py-1 text-[11px] font-medium shadow-card ${
            check && !check.ok ? 'bg-danger text-white' : 'bg-warning-500 text-white'
          }`}
        >
          {hint}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// "Move to…" menu — the keyboard / screen-reader / switch-access alternative to dragging
// ------------------------------------------------------------

function MoveJobMenu({ jobId, label, options }: { jobId: string; label: string; options: MoveTargetOption[] }) {
  const { plan, onMove } = useScheduleDnd();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  const toggle = () => {
    if (open) return close();
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 248)) });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])') ?? []);
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = items();
        const i = list.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        list[next]?.focus();
      }
    };
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close]);

  const groups = useMemo(() => {
    const map = new Map<string, MoveTargetOption[]>();
    options.forEach((o) => map.set(o.group ?? '', [...(map.get(o.group ?? '') ?? []), o]));
    return Array.from(map.entries());
  }, [options]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Move ${label} to…`}
        className="focus-ring flex h-6 items-center gap-1 rounded-md border border-border bg-bg-secondary px-1.5 text-[11px] font-medium text-text-secondary hover:text-text-primary"
      >
        <ArrowRightLeft size={11} /> Move
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Move ${label} to`}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: 240 }}
            className="z-[90] max-h-72 overflow-y-auto rounded-xl border border-border bg-bg-secondary p-1.5 shadow-card dark:shadow-card-dark"
          >
            {groups.map(([group, items]) => (
              <div key={group || 'all'} role="group" aria-label={group || undefined}>
                {group && <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">{group}</p>}
                {items.map((o) => {
                  const check = plan(jobId, o.target)?.check;
                  const same = check === undefined;
                  const blockedReason = check && !check.ok ? check.reason : null;
                  const warning = check?.ok ? check.warnings[0] : undefined;
                  return (
                    <button
                      key={o.key}
                      type="button"
                      role="menuitem"
                      disabled={same || blockedReason !== null}
                      title={blockedReason ?? undefined}
                      onClick={() => {
                        setOpen(false);
                        onMove(jobId, o.target);
                      }}
                      className="focus-ring flex w-full flex-col rounded-lg px-2 py-1.5 text-left text-xs text-text-primary hover:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span>{o.label}{same ? ' (current)' : ''}</span>
                      {blockedReason && <span className="text-[10px] text-danger">{blockedReason}</span>}
                      {warning && <span className="text-[10px] text-warning-500">{warning}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
