/**
 * AI Takeoff review workspace — /dashboard/takeoff/:id
 *
 * Human-in-the-loop: the AI drafts rooms, fixtures, quantities and prices with a
 * confidence per line. Staff confirm, correct or remove lines; the quote can only
 * be created once nothing uncertain is left undecided. All math comes from the
 * shared engine so the screen, the server and the quote always agree.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle2, FileText, Loader2, Ruler } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { ConfidenceBadge } from '@/components/takeoff/ConfidenceBadge';
import { TakeoffItemRow } from '@/components/takeoff/TakeoffItemRow';
import {
  STATUS_LABELS,
  addItem,
  analyzeTakeoff,
  computeLabor,
  computeTierTotals,
  convertToQuote,
  createManualItem,
  deleteItem,
  evaluateReviewGate,
  formatCents,
  getPlanUrl,
  isStaleAnalysis,
  loadTakeoff,
  projectInfo,
  projectSettings,
  repriceForMarkup,
  requiresReview,
  saveProjectSettings,
  summarizeAccuracy,
  TIER_ORDER,
  updateItem,
  updateManyPrices,
  type ItemPatch,
  type TakeoffItem,
  type TakeoffProject,
  type TakeoffRoom,
} from '@/lib/takeoff';

const fieldCls = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-2.5 py-2 text-sm text-text-primary';
const TIER_LABEL = { good: 'Good', better: 'Better', best: 'Best' } as const;

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function TakeoffDetailPage() {
  const { id = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const { user, isOwner, permissions, profileLoading } = useAuth();
  const { toast } = useToast();
  const canSeeCost = isOwner || Boolean(permissions?.can_view_billing);

  const [project, setProject] = useState<TakeoffProject | null>(null);
  const [rooms, setRooms] = useState<TakeoffRoom[]>([]);
  const [items, setItems] = useState<TakeoffItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [onlyReview, setOnlyReview] = useState(false);
  const [confirmReanalyze, setConfirmReanalyze] = useState(false);
  const [add, setAdd] = useState({ description: '', quantity: '1', price: '', unit: 'ea', kind: 'material' as 'material' | 'fixture' | 'fee' | 'labor', scope: 'all' as TakeoffItem['tier_scope'] });
  const loadSeq = useRef(0);
  const started = useRef(false);

  const load = useCallback(async () => {
    const mine = ++loadSeq.current;
    try {
      const res = await loadTakeoff(id);
      if (mine !== loadSeq.current) return;
      if (!res) return setMissing(true);
      setProject(res.project);
      setRooms(res.rooms);
      setItems(res.items);
    } catch (e) {
      if (mine === loadSeq.current) toast(e instanceof Error ? e.message : 'Could not load this takeoff.', 'error');
    }
    if (mine === loadSeq.current) setLoading(false);
  }, [id, toast]);

  useEffect(() => { void load(); }, [load]);

  const runAnalysis = useCallback(async () => {
    setAnalyzing(true);
    try {
      await analyzeTakeoff(id);
      toast('Analysis complete. Review the lines below.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Analysis failed.', 'error');
    }
    setAnalyzing(false);
    await load();
  }, [id, load, toast]);

  // Fresh upload lands here with ?start=1: begin the analysis once.
  useEffect(() => {
    if (search.get('start') === '1' && project && project.status === 'draft' && !started.current) {
      started.current = true;
      setSearch({}, { replace: true });
      void runAnalysis();
    }
  }, [search, project, runAnalysis, setSearch]);

  // Another tab / device is analyzing: poll until it finishes.
  useEffect(() => {
    if (!project || project.status !== 'analyzing' || analyzing) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [project, analyzing, load]);

  const settings = useMemo(() => (project ? projectSettings(project) : null), [project]);
  const gate = useMemo(() => (project && settings ? evaluateReviewGate(items, settings, projectInfo(project)) : null), [items, settings, project]);
  const tierTotals = useMemo(() => (settings ? TIER_ORDER.map((t) => computeTierTotals(items, settings, t)) : []), [items, settings]);
  const labor = useMemo(() => (settings ? computeLabor(items.filter((i) => i.review_status !== 'rejected'), settings) : null), [items, settings]);
  const accuracy = useMemo(() => summarizeAccuracy(items), [items]);
  const roomName = useMemo(() => new Map(rooms.map((r) => [r.id, r.name])), [rooms]);

  const locked = !project || project.status === 'converted' || project.status === 'analyzing' || busy || analyzing;

  const patchItem = async (item: TakeoffItem, patch: ItemPatch) => {
    const before = items;
    setItems((cur) => cur.map((i) => (i.id === item.id ? { ...i, ...patch } : i)));
    try { await updateItem(item.id, patch); }
    catch (e) { setItems(before); toast(e instanceof Error ? e.message : 'Could not save.', 'error'); }
  };

  const patchProject = async (patch: Parameters<typeof saveProjectSettings>[1]) => {
    if (!project) return;
    const prev = project;
    const next = { ...project, ...patch } as TakeoffProject;
    setProject(next);
    try {
      await saveProjectSettings(project.id, patch);
      if (patch.markup_percent != null && patch.markup_percent !== prev.markup_percent) {
        const changes = repriceForMarkup(items, patch.markup_percent);
        if (changes.length) {
          await updateManyPrices(changes);
          setItems((cur) => cur.map((i) => { const c = changes.find((x) => x.id === i.id); return c ? { ...i, unit_price_cents: c.unit_price_cents } : i; }));
          toast(`Re-priced ${changes.length} supplier line${changes.length === 1 ? '' : 's'} at the new markup.`, 'info');
        }
      }
    } catch (e) {
      setProject(prev);
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
    }
  };

  const confirmAllHighConfidence = async () => {
    const targets = items.filter((i) => i.review_status === 'pending' && !requiresReview(i));
    if (targets.length === 0) return;
    setBusy(true);
    try {
      for (const t of targets) await updateItem(t.id, { review_status: 'confirmed' });
      setItems((cur) => cur.map((i) => (targets.some((t) => t.id === i.id) ? { ...i, review_status: 'confirmed' } : i)));
      toast(`Confirmed ${targets.length} high-confidence line${targets.length === 1 ? '' : 's'}.`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not confirm lines.', 'error');
      await load();
    }
    setBusy(false);
  };

  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project) return;
    const qty = Number(add.quantity);
    const price = Number(add.price);
    if (!add.description.trim() || !(qty > 0) || !(price >= 0) || add.price.trim() === '') return toast('Enter a description, quantity and price.', 'error');
    setBusy(true);
    try {
      const row = await addItem(project.id, createManualItem({
        description: add.description, quantity: qty, unit_price_cents: Math.round(price * 100),
        unit: add.unit, kind: add.kind, tier_scope: add.scope, sort_order: items.length,
      }));
      setItems((cur) => [...cur, row]);
      setAdd({ ...add, description: '', quantity: '1', price: '' });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the line.', 'error');
    }
    setBusy(false);
  };

  const removeItem = async (item: TakeoffItem) => {
    try { await deleteItem(item.id); setItems((cur) => cur.filter((i) => i.id !== item.id)); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not remove.', 'error'); }
  };

  const convert = async () => {
    if (!project || !user) return;
    setBusy(true);
    try {
      const quoteId = await convertToQuote({ userId: user.id, project, items });
      toast('Draft quote created. Review it, then send it from Quotes.', 'success');
      navigate(`/dashboard/quotes/${quoteId}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the quote.', 'error');
      setBusy(false);
    }
  };

  const openPlan = async (path: string) => {
    const url = await getPlanUrl(path);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    else toast('Could not open that file.', 'error');
  };

  const back = (
    <Link to="/dashboard/takeoff" className="focus-ring mb-4 inline-flex items-center gap-1.5 rounded text-sm text-text-secondary hover:text-text-primary">
      <ArrowLeft size={14} /> All takeoffs
    </Link>
  );

  if (loading || profileLoading) {
    return <DashboardLayout activeLabel="AI Takeoff"><div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{back}<SkeletonCardList count={3} rows={3} /></div></DashboardLayout>;
  }
  if (missing || !project || !settings || !gate || !labor) {
    return <DashboardLayout activeLabel="AI Takeoff"><div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{back}
      <EmptyState icon={Ruler} title="Takeoff not found" description="It may have been deleted, or it belongs to another account." /></div></DashboardLayout>;
  }

  const stale = isStaleAnalysis(project);
  const isAnalyzing = (project.status === 'analyzing' && !stale) || analyzing;
  const canAnalyze = !isAnalyzing && project.status !== 'converted';
  const visible = items.filter((i) => !onlyReview || requiresReview(i) || i.unit_price_cents == null);
  const groups: { key: string; title: string; list: TakeoffItem[] }[] = [];
  for (const r of rooms) groups.push({ key: r.id, title: r.name, list: visible.filter((i) => i.room_id === r.id) });
  groups.push({ key: 'general', title: 'Whole project / general', list: visible.filter((i) => !i.room_id || !roomName.has(i.room_id)) });
  const quickConfirmable = items.filter((i) => i.review_status === 'pending' && !requiresReview(i)).length;

  return (
    <DashboardLayout activeLabel="AI Takeoff">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        {back}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold text-text-primary">{project.name}</h1>
            <p className="mt-1 text-sm text-text-secondary">
              {STATUS_LABELS[stale ? 'failed' : project.status]}
              {project.model ? ` · ${project.model}` : ''}
              {project.analyzed_at ? ` · analyzed ${new Date(project.analyzed_at).toLocaleString()}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canAnalyze && (
              <Button variant="secondary" size="sm" onClick={() => (items.some((i) => i.source === 'ai') ? setConfirmReanalyze(true) : void runAnalysis())} disabled={busy}>
                {project.status === 'draft' ? 'Analyze plans' : 'Re-analyze'}
              </Button>
            )}
            {project.status === 'converted' && project.quote_id && (
              <Button size="sm" onClick={() => navigate(`/dashboard/quotes/${project.quote_id}`)}><FileText size={14} /> Open quote</Button>
            )}
          </div>
        </div>

        {isAnalyzing && (
          <div className="mb-6 flex items-center gap-3 rounded-2xl border border-accent/30 bg-accent/5 p-4 text-sm text-text-primary" role="status">
            <Loader2 className="animate-spin text-accent" size={18} aria-hidden />
            Reading your plans… this usually takes 30–90 seconds. You can leave this page; it will be ready when you return.
          </div>
        )}
        {(project.status === 'failed' || stale) && (
          <div className="mb-6 flex items-start gap-3 rounded-2xl border border-danger/30 bg-danger/5 p-4 text-sm text-text-primary" role="alert">
            <AlertTriangle className="mt-0.5 text-danger" size={18} aria-hidden />
            <span>{stale ? 'The analysis stalled.' : project.analysis_error || 'The analysis failed.'} Use “Re-analyze” to try again.</span>
          </div>
        )}

        {project.status !== 'draft' && items.length > 0 && (
          <>
            <Section title="What the AI found" aside={project.overall_confidence != null ? <ConfidenceBadge confidence={project.overall_confidence} /> : null}>
              {project.ai_summary && <p className="text-sm text-text-primary">{project.ai_summary}</p>}
              <p className="mt-2 text-xs text-text-secondary">
                Plan quality: {project.plan_quality ?? 'unknown'} · Scale: {project.scale_note ?? 'not found'} · {rooms.length} room{rooms.length === 1 ? '' : 's'} · {items.length} line{items.length === 1 ? '' : 's'}
              </p>
              {[...project.warnings, ...project.missing_info].length > 0 && (
                <ul className="mt-3 space-y-1 text-sm text-warning-500">
                  {[...project.warnings, ...project.missing_info].map((w, i) => <li key={i} className="flex gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />{w}</li>)}
                </ul>
              )}
              {project.assumptions.length > 0 && (
                <details className="mt-3 text-sm text-text-secondary">
                  <summary className="cursor-pointer text-text-primary">Assumptions the AI made ({project.assumptions.length})</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">{project.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
                </details>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {project.source_files.map((f) => (
                  <button key={f.path} type="button" onClick={() => void openPlan(f.path)} className="focus-ring rounded-full border border-border px-3 py-1 text-xs text-text-secondary hover:border-accent hover:text-accent">
                    {f.name}
                  </button>
                ))}
              </div>
            </Section>

            <Section title="Pricing settings">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <label className="text-xs text-text-secondary">Customer
                  <input key={project.customer_name} className={fieldCls} defaultValue={project.customer_name} disabled={locked} maxLength={160}
                    onBlur={(e) => e.target.value !== project.customer_name && void patchProject({ customer_name: e.target.value.trim() })} /></label>
                <label className="text-xs text-text-secondary">Material markup %
                  <input key={project.markup_percent} className={fieldCls} inputMode="decimal" defaultValue={project.markup_percent} disabled={locked}
                    onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0 && v <= 500 && v !== project.markup_percent) void patchProject({ markup_percent: v }); }} /></label>
                <label className="text-xs text-text-secondary">Labor rate $/hr
                  <input key={project.labor_rate_cents} className={`${fieldCls} ${labor.missingRate ? 'border-danger' : ''}`} inputMode="decimal" defaultValue={(project.labor_rate_cents / 100).toFixed(2)} disabled={locked}
                    onBlur={(e) => { const v = Math.round(Number(e.target.value) * 100); if (Number.isFinite(v) && v >= 0 && v !== project.labor_rate_cents) void patchProject({ labor_rate_cents: v }); }} /></label>
                {canSeeCost && (
                  <label className="text-xs text-text-secondary">Labor cost $/hr (internal)
                    <input key={project.labor_cost_rate_cents} className={fieldCls} inputMode="decimal" defaultValue={project.labor_cost_rate_cents != null ? (project.labor_cost_rate_cents / 100).toFixed(2) : ''} disabled={locked}
                      onBlur={(e) => { const raw = e.target.value.trim(); const v = raw === '' ? null : Math.round(Number(raw) * 100); if (v === null || (Number.isFinite(v) && v >= 0)) void patchProject({ labor_cost_rate_cents: v }); }} /></label>
                )}
                <label className="text-xs text-text-secondary">Tax %
                  <input key={project.tax_percent} className={fieldCls} inputMode="decimal" defaultValue={project.tax_percent} disabled={locked}
                    onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0 && v <= 100 && v !== project.tax_percent) void patchProject({ tax_percent: v }); }} /></label>
              </div>
              <label className="mt-3 flex items-center gap-2 text-xs text-text-secondary">
                Quote detail
                <select className={`${fieldCls} !w-auto`} value={project.detail_level} disabled={locked} onChange={(e) => void patchProject({ detail_level: e.target.value as 'itemized' | 'summary' })}>
                  <option value="itemized">Itemized (every material line)</option>
                  <option value="summary">Summary (one line per trade)</option>
                </select>
              </label>
            </Section>

            <Section
              title={`Line items (${items.filter((i) => i.review_status !== 'rejected').length})`}
              aside={
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                    <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} /> Needs review only
                  </label>
                  {quickConfirmable > 0 && <Button size="sm" variant="secondary" disabled={locked} onClick={() => void confirmAllHighConfidence()}>Confirm {quickConfirmable} high-confidence</Button>}
                </div>
              }
            >
              {groups.filter((g) => g.list.length > 0).map((g) => (
                <div key={g.key} className="mb-5 last:mb-0">
                  <h3 className="mb-2 text-sm font-semibold text-text-primary">
                    {g.title}
                    {(() => { const r = rooms.find((x) => x.id === g.key); return r ? <span className="ml-2 font-normal text-text-secondary">{r.area_sqft ? `${r.area_sqft} sq ft` : ''}{r.length_ft && r.width_ft ? ` · ${r.length_ft}×${r.width_ft} ft` : ''}</span> : null; })()}
                  </h3>
                  <ul className="space-y-2">
                    {g.list.map((it) => (
                      <TakeoffItemRow key={it.id} item={it} markupPercent={project.markup_percent} canSeeCost={canSeeCost} disabled={locked} onPatch={patchItem} onDelete={removeItem} />
                    ))}
                  </ul>
                </div>
              ))}
              {visible.length === 0 && <p className="text-sm text-text-secondary">{onlyReview ? 'Nothing left to review. ' : 'No lines yet. '}</p>}

              <form onSubmit={submitAdd} className="mt-5 grid gap-2 border-t border-border pt-4 sm:grid-cols-[1fr_72px_72px_96px_110px_auto]">
                <input className={fieldCls} placeholder="Add a line (e.g. Permit fee)" value={add.description} disabled={locked} maxLength={160} onChange={(e) => setAdd({ ...add, description: e.target.value })} aria-label="New line description" />
                <input className={fieldCls} inputMode="decimal" placeholder="Qty" value={add.quantity} disabled={locked} onChange={(e) => setAdd({ ...add, quantity: e.target.value })} aria-label="New line quantity" />
                <input className={fieldCls} placeholder="Unit" value={add.unit} disabled={locked} maxLength={12} onChange={(e) => setAdd({ ...add, unit: e.target.value })} aria-label="New line unit" />
                <input className={fieldCls} inputMode="decimal" placeholder="Price $" value={add.price} disabled={locked} onChange={(e) => setAdd({ ...add, price: e.target.value })} aria-label="New line unit price" />
                <select className={fieldCls} value={add.kind} disabled={locked} onChange={(e) => setAdd({ ...add, kind: e.target.value as typeof add.kind })} aria-label="New line type">
                  <option value="material">Material</option><option value="fixture">Fixture</option><option value="fee">Fee</option><option value="labor">Labor</option>
                </select>
                <Button type="submit" size="sm" variant="secondary" disabled={locked}>Add</Button>
              </form>
            </Section>

            <Section title="Estimate by tier">
              <div className="grid gap-3 sm:grid-cols-3">
                {tierTotals.map((t) => (
                  <div key={t.tier} className="rounded-xl border border-border p-3">
                    <p className="text-sm font-semibold text-text-primary">{TIER_LABEL[t.tier]}</p>
                    <p className="mt-1 text-2xl font-bold text-text-primary">{formatCents(t.totalCents)}</p>
                    <dl className="mt-2 space-y-0.5 text-xs text-text-secondary">
                      <div className="flex justify-between"><dt>Materials &amp; fixtures</dt><dd>{formatCents(t.materialsCents)}</dd></div>
                      <div className="flex justify-between"><dt>Labor ({t.laborHours} hrs)</dt><dd>{formatCents(t.laborCents)}</dd></div>
                      {t.feesCents > 0 && <div className="flex justify-between"><dt>Fees</dt><dd>{formatCents(t.feesCents)}</dd></div>}
                      {t.taxCents > 0 && <div className="flex justify-between"><dt>Tax</dt><dd>{formatCents(t.taxCents)}</dd></div>}
                      {canSeeCost && t.marginPercent != null && (
                        <div className="flex justify-between border-t border-border/60 pt-1"><dt>Margin ({Math.round(t.costCoverage * 100)}% costed)</dt><dd>{t.marginPercent}%</dd></div>
                      )}
                    </dl>
                  </div>
                ))}
              </div>
              {labor.groups.length > 0 && (
                <div className="mt-4">
                  <p className="mb-1 text-xs font-medium text-text-primary">Labor hours by trade (edit to override the computed hours)</p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {labor.groups.map((g) => (
                      <label key={g.category} className="text-xs text-text-secondary">{g.category} — computed {g.computedHours}h
                        <input key={`${g.category}-${g.hours}`} className={fieldCls} inputMode="decimal" defaultValue={g.hours} disabled={locked}
                          onBlur={(e) => {
                            const raw = e.target.value.trim();
                            const next = { ...project.labor_overrides };
                            if (raw === '' || Number(raw) === g.computedHours) delete next[g.category];
                            else if (Number.isFinite(Number(raw)) && Number(raw) >= 0) next[g.category] = Number(raw);
                            else return;
                            void patchProject({ labor_overrides: next });
                          }} />
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </Section>

            <Section title="Review & create quote">
              {project.status === 'converted' ? (
                <p className="flex items-center gap-2 text-sm text-success-500"><CheckCircle2 size={16} aria-hidden /> A draft quote was created from this takeoff.</p>
              ) : (
                <>
                  <p className="text-sm text-text-secondary">
                    {gate.counts.pendingReview} line{gate.counts.pendingReview === 1 ? '' : 's'} need a decision · {gate.counts.confirmed + gate.counts.edited} verified · {gate.counts.rejected} removed
                    {accuracy.hitRate != null ? ` · AI accepted unchanged on ${Math.round(accuracy.hitRate * 100)}% of reviewed lines` : ''}
                  </p>
                  {gate.blockers.length > 0 && (
                    <ul className="mt-3 space-y-1 text-sm text-warning-500">
                      {gate.blockers.map((b) => <li key={b.code} className="flex gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />{b.message}</li>)}
                    </ul>
                  )}
                  {gate.warnings.length > 0 && <ul className="mt-2 space-y-1 text-xs text-text-secondary">{gate.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button onClick={() => void convert()} disabled={!gate.canConvert || locked}>{busy ? 'Creating…' : 'Create tiered draft quote'}</Button>
                    <span className="text-xs text-text-secondary">Creates a draft only. Nothing is sent to the customer.</span>
                  </div>
                </>
              )}
            </Section>
          </>
        )}

        {project.status === 'draft' && !isAnalyzing && (
          <EmptyState icon={Ruler} title="Ready to analyze" description={`${project.source_files.length} file(s) uploaded. The AI will extract rooms, fixtures and quantities for your review.`}
            action={{ label: 'Analyze plans', onClick: () => void runAnalysis() }} />
        )}
      </div>

      <ConfirmDialog
        open={confirmReanalyze}
        title="Re-analyze these plans?"
        description="AI lines and rooms are replaced with a fresh analysis. Lines you added yourself are kept; your corrections to AI lines are lost."
        confirmLabel="Re-analyze"
        onCancel={() => setConfirmReanalyze(false)}
        onConfirm={async () => { setConfirmReanalyze(false); await runAnalysis(); }}
      />
    </DashboardLayout>
  );
}
