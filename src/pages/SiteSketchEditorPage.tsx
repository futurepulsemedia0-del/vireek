/**
 * Site Sketch editor — /dashboard/site-sketches/:id  (id = "new" or a sketch uuid)
 * Optional query: ?job=<uuid> or ?quote=<uuid> to attach a new sketch on first save.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, AppWindow, ArrowLeft, Copy, DoorOpen, Hand, Link2, Maximize2, MousePointer2, PenLine, PencilRuler,
  Redo2, Ruler, Save, Square, StickyNote, Undo2,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCard } from '@/components/Skeleton';
import { SketchCanvas, type SketchTool } from '@/components/sketch/SketchCanvas';
import { LengthField, SketchInspector } from '@/components/sketch/SketchInspector';
import {
  docTotals, emptyDoc, formatArea, formatLength, historyCommit, historyInit, historyRedo, historyUndo, newId, parseSketchDoc,
  polygonArea, removeElement, setCeilingHeight, setUnit, type History, type SketchDoc, type SketchSelection, type UnitSystem,
} from '@/lib/siteSketch';
import {
  fetchAttachTargets, fetchSiteSketch, fetchTargetLabel, isSketchConflict, saveSiteSketch, sketchErrorMessage, type AttachTarget,
} from '@/lib/siteSketchApi';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIT_KEY = 'vireek.sketch.unit';
const draftKey = (k: string) => `vireek.sketch.draft.${k}`;

interface Baseline { json: string; title: string; jobId: string | null; quoteId: string | null }
interface Draft { sketchId: string; title: string; doc: unknown; jobId: string | null; quoteId: string | null; baseRevision: number | null }

const TOOLS: { key: SketchTool; label: string; icon: typeof Hand; help: string }[] = [
  { key: 'select', label: 'Select', icon: MousePointer2, help: 'Tap an item to edit it. Drag the round handles to move corners. Drag empty space to pan.' },
  { key: 'pan', label: 'Pan', icon: Hand, help: 'Drag to move around. Pinch with two fingers to zoom.' },
  { key: 'wall', label: 'Wall', icon: PenLine, help: 'Press to aim, release to drop a point. Tap "Finish walls" when done.' },
  { key: 'room', label: 'Room', icon: Square, help: 'Tap each corner of the room, then "Close room". Walls and floor area are added for you.' },
  { key: 'dimension', label: 'Measure', icon: Ruler, help: 'Tap two points to add a measured distance.' },
  { key: 'door', label: 'Door', icon: DoorOpen, help: 'Tap a wall to place a door.' },
  { key: 'window', label: 'Window', icon: AppWindow, help: 'Tap a wall to place a window.' },
  { key: 'note', label: 'Note', icon: StickyNote, help: 'Tap where the note belongs, then type it below.' },
];

function readUnit(): UnitSystem {
  try {
    return localStorage.getItem(UNIT_KEY) === 'metric' ? 'metric' : 'imperial';
  } catch {
    return 'imperial';
  }
}
function readDraft(key: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(key));
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}
function writeDraft(key: string, d: Draft) {
  try {
    localStorage.setItem(draftKey(key), JSON.stringify(d));
  } catch {
    /* storage full or blocked — drafts are best-effort */
  }
}
function clearDraft(key: string) {
  try {
    localStorage.removeItem(draftKey(key));
  } catch {
    /* ignore */
  }
}
function existsIn(doc: SketchDoc, s: SketchSelection): boolean {
  if (!s) return true;
  const list: { id: string }[] =
    s.kind === 'wall' ? doc.walls : s.kind === 'room' ? doc.rooms : s.kind === 'dimension' ? doc.dimensions : s.kind === 'opening' ? doc.openings : doc.notes;
  return list.some((e) => e.id === s.id);
}

export function SiteSketchEditorPage() {
  const { id: routeId } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, isOwner, permissions } = useAuth();
  const manager = isOwner || permissions.can_view_all_jobs;
  const isNew = routeId === 'new';
  const validId = isNew || (!!routeId && UUID_RE.test(routeId));
  const storeKey = isNew ? 'new' : routeId ?? 'new';

  const [phase, setPhase] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [sketchId, setSketchId] = useState(() => newId());
  const [title, setTitle] = useState('Untitled sketch');
  const [history, setHistory] = useState<History>(() => historyInit(emptyDoc()));
  const [preview, setPreview] = useState<SketchDoc | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<Baseline>({ json: '', title: '', jobId: null, quoteId: null });
  const [tool, setTool] = useState<SketchTool>('select');
  const [selection, setSelection] = useState<SketchSelection>(null);
  const [gridSnap, setGridSnap] = useState(true);
  const [ortho, setOrtho] = useState(true);
  const [showLengths, setShowLengths] = useState(true);
  const [fitSignal, setFitSignal] = useState(0);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [recovered, setRecovered] = useState<Draft | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [targets, setTargets] = useState<{ jobs: AttachTarget[]; quotes: AttachTarget[] } | null>(null);
  const [labels, setLabels] = useState<{ job: string | null; quote: string | null }>({ job: null, quote: null });

  const loadedFor = useRef<string | null>(null);
  const reqId = useRef(0);
  const savingRef = useRef(false);

  const doc = preview ?? history.present;
  const json = useMemo(() => JSON.stringify(history.present), [history.present]);
  const dirty = phase === 'ready' && (json !== baseline.json || title !== baseline.title || jobId !== baseline.jobId || quoteId !== baseline.quoteId);
  const totals = useMemo(() => docTotals(doc), [doc]);
  const unit = doc.unit;

  const applyLoaded = useCallback((d: { sketchId: string; title: string; doc: SketchDoc; revision: number | null; jobId: string | null; quoteId: string | null }) => {
    setSketchId(d.sketchId);
    setTitle(d.title);
    setHistory(historyInit(d.doc));
    setPreview(null);
    setSelection(null);
    setTool('select');
    setRevision(d.revision);
    setJobId(d.jobId);
    setQuoteId(d.quoteId);
    setConflict(false);
    setBaseline({ json: JSON.stringify(d.doc), title: d.title, jobId: d.jobId, quoteId: d.quoteId });
    setFitSignal((n) => n + 1);
  }, []);

  const loadSketch = useCallback(async () => {
    if (!user) return;
    if (!validId || !routeId) return setPhase('missing');
    const req = ++reqId.current;
    setRecovered(null);
    if (isNew) {
      const q = params.get('quote');
      const j = params.get('job');
      applyLoaded({
        sketchId: newId(),
        title: 'Untitled sketch',
        doc: emptyDoc(readUnit()),
        revision: null,
        jobId: j && UUID_RE.test(j) ? j : null,
        quoteId: manager && q && UUID_RE.test(q) ? q : null,
      });
      const d = readDraft('new');
      if (d && d.doc) setRecovered(d);
      loadedFor.current = 'new';
      return setPhase('ready');
    }
    setPhase('loading');
    try {
      const rec = await fetchSiteSketch(routeId);
      if (req !== reqId.current) return;
      if (!rec) return setPhase('missing');
      applyLoaded({ sketchId: rec.id, title: rec.title, doc: rec.doc, revision: rec.revision, jobId: rec.job_id, quoteId: rec.quote_id });
      const d = readDraft(routeId);
      if (d && d.baseRevision === rec.revision && JSON.stringify(parseSketchDoc(d.doc, rec.unit)) !== JSON.stringify(rec.doc)) setRecovered(d);
      else if (d) clearDraft(routeId);
      loadedFor.current = routeId;
      setPhase('ready');
    } catch {
      if (req === reqId.current) setPhase('error');
    }
  }, [user, validId, routeId, isNew, params, manager, applyLoaded]);

  useEffect(() => {
    if (routeId && loadedFor.current === routeId) return;
    void loadSketch();
  }, [routeId, loadSketch]);

  // ---- local draft backup ----
  useEffect(() => {
    if (phase !== 'ready') return;
    if (!dirty) {
      if (!recovered) clearDraft(storeKey);
      return;
    }
    const t = setTimeout(() => writeDraft(storeKey, { sketchId, title, doc: history.present, jobId, quoteId, baseRevision: revision }), 700);
    return () => clearTimeout(t);
  }, [phase, dirty, storeKey, sketchId, title, history.present, jobId, quoteId, revision, recovered]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), 4500);
    return () => clearTimeout(t);
  }, [hint]);

  useEffect(() => {
    if (!existsIn(history.present, selection)) setSelection(null);
  }, [history.present, selection]);

  // ---- attach labels / targets ----
  useEffect(() => {
    let off = false;
    if (jobId) void fetchTargetLabel('job', jobId).then((l) => !off && setLabels((p) => ({ ...p, job: l })));
    else setLabels((p) => ({ ...p, job: null }));
    if (quoteId) void fetchTargetLabel('quote', quoteId).then((l) => !off && setLabels((p) => ({ ...p, quote: l })));
    else setLabels((p) => ({ ...p, quote: null }));
    return () => {
      off = true;
    };
  }, [jobId, quoteId]);

  useEffect(() => {
    if (!attachOpen || targets) return;
    let off = false;
    fetchAttachTargets(manager)
      .then((t) => !off && setTargets(t))
      .catch(() => !off && setTargets({ jobs: [], quotes: [] }));
    return () => {
      off = true;
    };
  }, [attachOpen, targets, manager]);

  // ---- editing ----
  const commit = useCallback((next: SketchDoc, nextSel?: SketchSelection) => {
    setHistory((h) => historyCommit(h, next));
    setPreview(null);
    if (nextSel !== undefined) {
      setSelection(nextSel);
      if (nextSel?.kind === 'note') setTool('select');
    }
  }, []);

  const undo = useCallback(() => setHistory((h) => historyUndo(h)), []);
  const redo = useCallback(() => setHistory((h) => historyRedo(h)), []);
  const deleteSelected = useCallback(() => {
    if (!selection) return;
    commit(removeElement(history.present, selection));
    setSelection(null);
  }, [selection, history.present, commit]);

  const save = useCallback(
    async (asCopy = false) => {
      if (savingRef.current || phase !== 'ready') return;
      savingRef.current = true;
      setSaving(true);
      setConflict(false);
      const snapDoc = history.present;
      const baseTitle = title.trim() || 'Untitled sketch';
      const finalTitle = asCopy ? `${baseTitle} (copy)`.slice(0, 120) : baseTitle;
      const id = asCopy ? newId() : sketchId;
      try {
        const res = await saveSiteSketch({ id, title: finalTitle, doc: snapDoc, jobId, quoteId, expectedRevision: asCopy ? null : revision });
        clearDraft(storeKey);
        clearDraft(id);
        setSketchId(id);
        setRevision(res.revision);
        setTitle(finalTitle);
        setBaseline({ json: JSON.stringify(snapDoc), title: finalTitle, jobId, quoteId });
        loadedFor.current = id;
        if (routeId !== id) navigate(`/dashboard/site-sketches/${id}`, { replace: true });
        toast(asCopy ? 'Saved as a copy' : 'Sketch saved', 'success');
      } catch (err) {
        if (isSketchConflict(err)) setConflict(true);
        else toast(sketchErrorMessage(err), 'error');
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [phase, history.present, title, sketchId, jobId, quoteId, revision, storeKey, routeId, navigate, toast],
  );

  const backTo = jobId ? `/dashboard/jobs/${jobId}` : quoteId ? `/dashboard/quotes/${quoteId}` : '/dashboard/site-sketches';
  const goBack = () => (dirty ? setConfirmLeave(true) : navigate(backTo));

  // ---- keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      } else if (typing) {
        return;
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection) {
        e.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, undo, redo, deleteSelected, selection]);

  const changeUnit = (u: UnitSystem) => {
    try {
      localStorage.setItem(UNIT_KEY, u);
    } catch {
      /* ignore */
    }
    commit(setUnit(history.present, u));
  };

  const copySummary = async () => {
    const t = totals;
    const lines = [
      `${title} — site sketch`,
      ...history.present.rooms.map((r) => `${r.name}: ${formatArea(polygonArea(r.points), unit)}`),
      `Total floor area: ${formatArea(t.floorAreaMm2, unit)}`,
      `Wall length: ${formatLength(t.wallLengthMm, unit)}`,
      `Gross wall area (${formatLength(history.present.ceiling_height_mm, unit)} ceiling): ${formatArea(t.grossWallAreaMm2, unit)}`,
      `Doors: ${t.doorCount} · Windows: ${t.windowCount}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast('Measurements copied', 'success');
    } catch {
      toast('Could not copy. Select the numbers manually.', 'error');
    }
  };

  // ---------------- render ----------------
  if (phase === 'loading') {
    return (
      <DashboardLayout activeLabel="Site Sketches">
        <div aria-busy="true" aria-label="Loading sketch" className="space-y-4">
          <SkeletonCard rows={1} />
          <SkeletonCard rows={5} />
        </div>
      </DashboardLayout>
    );
  }
  if (phase === 'missing' || phase === 'error') {
    return (
      <DashboardLayout activeLabel="Site Sketches">
        <EmptyState
          icon={phase === 'error' ? AlertTriangle : PencilRuler}
          title={phase === 'error' ? "Couldn't load this sketch" : 'Sketch not found'}
          description={phase === 'error' ? 'Check your connection and try again.' : 'It may have been deleted, or you may not have access to it.'}
          action={phase === 'error' ? { label: 'Retry', onClick: () => { loadedFor.current = null; void loadSketch(); } } : { label: 'Back to sketches', onClick: () => navigate('/dashboard/site-sketches') }}
        />
      </DashboardLayout>
    );
  }

  const tool0 = TOOLS.find((t) => t.key === tool) ?? TOOLS[0];
  const iconBtn = 'focus-ring inline-flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-primary disabled:opacity-40';
  const toggle = (on: boolean) => `focus-ring min-h-[40px] whitespace-nowrap rounded-xl px-3 text-sm font-semibold ${on ? 'bg-accent/15 text-accent' : 'border border-border bg-bg-secondary text-text-secondary'}`;
  const sel = 'focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary disabled:opacity-60';

  return (
    <DashboardLayout activeLabel="Site Sketches">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={goBack} aria-label="Back" className={iconBtn}>
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <input
            aria-label="Sketch title"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            className="focus-ring min-w-0 flex-1 rounded-xl border border-transparent bg-transparent px-2 py-2 text-lg font-bold text-text-primary hover:border-border"
          />
          <button type="button" onClick={undo} disabled={!history.past.length} aria-label="Undo" className={iconBtn}><Undo2 size={18} aria-hidden="true" /></button>
          <button type="button" onClick={redo} disabled={!history.future.length} aria-label="Redo" className={iconBtn}><Redo2 size={18} aria-hidden="true" /></button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !dirty}
            className="focus-ring inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50"
          >
            <Save size={16} aria-hidden="true" /> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        <p className="px-1 text-xs text-text-secondary" role="status" aria-live="polite">
          {saving ? 'Saving…' : dirty ? 'Unsaved changes' : revision ? 'All changes saved' : 'Not saved yet'}
        </p>

        {recovered && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-text-primary">
            <span>We found unsaved edits from this device.</span>
            <span className="flex gap-2">
              <button type="button" className="focus-ring min-h-[40px] rounded-xl bg-accent px-3 font-semibold text-white" onClick={() => {
                const d = recovered;
                setSketchId(d.sketchId);
                setTitle(d.title);
                setJobId(d.jobId);
                setQuoteId(manager ? d.quoteId : null);
                commit(parseSketchDoc(d.doc, readUnit()));
                setRecovered(null);
                setFitSignal((n) => n + 1);
              }}>Restore</button>
              <button type="button" className="focus-ring min-h-[40px] rounded-xl border border-border px-3 font-semibold" onClick={() => { clearDraft(storeKey); setRecovered(null); }}>Discard</button>
            </span>
          </div>
        )}

        {conflict && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-text-primary">
            <span>This sketch was changed on another device. Loading the latest version replaces your unsaved edits.</span>
            <span className="flex gap-2">
              <button type="button" className="focus-ring min-h-[40px] rounded-xl border border-border px-3 font-semibold" onClick={() => void save(true)}>Save as copy</button>
              <button type="button" className="focus-ring min-h-[40px] rounded-xl bg-accent px-3 font-semibold text-white" onClick={() => { clearDraft(storeKey); loadedFor.current = null; void loadSketch(); }}>Load latest</button>
            </span>
          </div>
        )}

        <div className="flex gap-1.5 overflow-x-auto pb-1" role="toolbar" aria-label="Sketch tools">
          {TOOLS.map((t) => (
            <button
              key={t.key}
              type="button"
              aria-pressed={tool === t.key}
              onClick={() => setTool(t.key)}
              className={`focus-ring flex min-h-[52px] min-w-[60px] flex-col items-center justify-center gap-0.5 rounded-xl px-2 text-[11px] font-semibold ${tool === t.key ? 'bg-accent text-white' : 'border border-border bg-bg-secondary text-text-primary'}`}
            >
              <t.icon size={18} aria-hidden="true" />
              {t.label}
            </button>
          ))}
        </div>

        <p className="px-1 text-xs text-text-secondary" role="status" aria-live="polite">{hint ?? tool0.help}</p>

        <div style={{ height: 'min(66dvh, 720px)', minHeight: 340 }}>
          <SketchCanvas
            doc={doc}
            tool={tool}
            selection={selection}
            gridSnap={gridSnap}
            ortho={ortho}
            showLengths={showLengths}
            fitSignal={fitSignal}
            onSelect={setSelection}
            onPreview={setPreview}
            onCommit={commit}
            onHint={setHint}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={toggle(gridSnap)} aria-pressed={gridSnap} onClick={() => setGridSnap((v) => !v)}>Grid snap</button>
          <button type="button" className={toggle(ortho)} aria-pressed={ortho} onClick={() => setOrtho((v) => !v)}>Straight lines</button>
          <button type="button" className={toggle(showLengths)} aria-pressed={showLengths} onClick={() => setShowLengths((v) => !v)}>Wall lengths</button>
          <button type="button" className={toggle(false)} onClick={() => setFitSignal((n) => n + 1)}><Maximize2 size={14} className="mr-1 inline" aria-hidden="true" />Fit</button>
          <div className="ml-auto inline-flex rounded-xl border border-border p-0.5" role="group" aria-label="Units">
            {(['imperial', 'metric'] as const).map((u) => (
              <button key={u} type="button" aria-pressed={unit === u} onClick={() => changeUnit(u)} className={`focus-ring min-h-[36px] rounded-lg px-3 text-sm font-semibold ${unit === u ? 'bg-accent text-white' : 'text-text-secondary'}`}>
                {u === 'imperial' ? 'ft / in' : 'm / mm'}
              </button>
            ))}
          </div>
        </div>

        <section className="rounded-2xl border border-border bg-bg-secondary p-4" aria-label="Selected item">
          <SketchInspector doc={history.present} selection={selection} onChange={commit} onDelete={deleteSelected} />
        </section>

        <section className="rounded-2xl border border-border bg-bg-secondary p-4" aria-label="Measurements">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-text-primary">Measurements</h2>
            <button type="button" onClick={() => void copySummary()} className="focus-ring inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-border px-3 text-sm font-semibold text-text-primary hover:bg-bg-tertiary">
              <Copy size={14} aria-hidden="true" /> Copy
            </button>
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Floor area', formatArea(totals.floorAreaMm2, unit), `${totals.roomCount} ${totals.roomCount === 1 ? 'room' : 'rooms'}`],
              ['Wall length', formatLength(totals.wallLengthMm, unit), `${doc.walls.length} walls`],
              ['Gross wall area', formatArea(totals.grossWallAreaMm2, unit), 'room perimeter × ceiling'],
              ['Openings', `${totals.doorCount} doors · ${totals.windowCount} windows`, ''],
            ].map(([k, v, hnt]) => (
              <div key={k}>
                <dt className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{k}</dt>
                <dd className="mt-0.5 text-lg font-bold tabular-nums text-text-primary">{v}</dd>
                {hnt && <dd className="text-xs text-text-secondary">{hnt}</dd>}
              </div>
            ))}
          </dl>
          <div className="mt-4 max-w-xs">
            <LengthField id="ceiling" label="Ceiling height" valueMm={history.present.ceiling_height_mm} unit={unit} onCommit={(mm) => commit(setCeilingHeight(history.present, mm))} />
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-bg-secondary p-4" aria-label="Attachments">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Link2 size={15} aria-hidden="true" /> Attached to</h2>
            <button type="button" onClick={() => setAttachOpen((v) => !v)} aria-expanded={attachOpen} className="focus-ring min-h-[40px] rounded-xl border border-border px-3 text-sm font-semibold text-text-primary hover:bg-bg-tertiary">
              {attachOpen ? 'Done' : 'Change'}
            </button>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            {jobId || quoteId ? [jobId && `Job · ${labels.job ?? 'loading…'}`, quoteId && `Quote · ${labels.quote ?? 'loading…'}`].filter(Boolean).join('   ') : 'Not attached to a job or quote.'}
          </p>
          {attachOpen && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="attach-job" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-text-secondary">Job</label>
                <select id="attach-job" className={sel} value={jobId ?? ''} disabled={!targets} onChange={(e) => setJobId(e.target.value || null)}>
                  <option value="">{targets ? 'None' : 'Loading…'}</option>
                  {jobId && !targets?.jobs.some((j) => j.id === jobId) && <option value={jobId}>{labels.job ?? 'Current job'}</option>}
                  {targets?.jobs.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="attach-quote" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-text-secondary">Quote</label>
                <select id="attach-quote" className={sel} value={quoteId ?? ''} disabled={!targets || !manager} onChange={(e) => setQuoteId(e.target.value || null)}>
                  <option value="">{targets ? 'None' : 'Loading…'}</option>
                  {quoteId && !targets?.quotes.some((q) => q.id === quoteId) && <option value={quoteId}>{labels.quote ?? 'Current quote'}</option>}
                  {targets?.quotes.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
                </select>
                {!manager && <p className="mt-1 text-xs text-text-secondary">Only managers can attach sketches to quotes.</p>}
              </div>
            </div>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={confirmLeave}
        title="Leave without saving?"
        description="You have unsaved changes to this sketch. They will stay on this device as a draft, but won't be saved to your account."
        confirmLabel="Leave"
        onConfirm={() => {
          setConfirmLeave(false);
          navigate(backTo);
        }}
        onCancel={() => setConfirmLeave(false)}
      />
    </DashboardLayout>
  );
}
