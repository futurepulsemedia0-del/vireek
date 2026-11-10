import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  createProject, fetchJurisdictions, fetchProjects, friendlySolarError, saveJurisdiction, updateProject, useAsyncData, verifyJurisdiction, type SolarJurisdiction, type SolarProject,
} from '@/lib/solarApi';
import { SOLAR_STAGE_KEYS, SOLAR_STAGE_LABELS, REQUIRES_COUNSEL_NOTICE, jurisdictionNeedsVerification, validateReviewDays, type SolarStageKey } from '@/lib/tradePacks/solarPipeline';
import { MONITORING_PROVIDERS, expectedDailyKwh, getMonitoringAdapter, summarizeProduction, type ProductionSnapshot } from '@/lib/tradePacks/solarMonitoring';
import { SolarPipelineView } from './SolarPipelineView';
import { SolarEquipmentView } from './SolarEquipmentView';
import { SolarClaimsView } from './SolarClaimsView';
import { Pill, SelectField } from './shared';

type Tab = 'pipeline' | 'equipment' | 'claims' | 'production' | 'jurisdictions';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'pipeline', label: 'Pipeline' }, { key: 'equipment', label: 'Equipment & warranty' }, { key: 'claims', label: 'Warranty claims' },
  { key: 'production', label: 'Production' }, { key: 'jurisdictions', label: 'Jurisdictions' },
];

function CounselBanner() {
  return (
    <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-text-primary" role="note">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" /> <span>{REQUIRES_COUNSEL_NOTICE}</span>
    </p>
  );
}

function ProductionCard({ project }: { project: SolarProject }) {
  const [snap, setSnap] = useState<ProductionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const adapter = getMonitoringAdapter(project.monitoring_provider);
  useEffect(() => {
    setSnap(null); setError(null);
    if (!adapter || !project.monitoring_site_ref) return;
    let live = true;
    setLoading(true);
    const to = new Date(); const from = new Date(to.getTime() - 13 * 86_400_000);
    adapter.getProduction(project.monitoring_site_ref, { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) })
      .then((s) => live && setSnap(s)).catch(() => live && setError('Could not read production data.')).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [adapter, project.monitoring_site_ref]);
  if (!adapter) return <p className="text-sm text-text-secondary">Production monitoring is not connected for this project. No vendor integration ships in this build; a mock source is available for testing.</p>;
  if (!project.monitoring_site_ref) return <p className="text-sm text-text-secondary">Add a monitoring site reference to see production.</p>;
  if (loading) return <Skeleton className="h-24 w-full rounded-2xl" />;
  if (error) return <p className="text-sm text-danger" role="alert">{error}</p>;
  if (!snap) return null;
  const sum = summarizeProduction(snap, project.system_size_kw ? expectedDailyKwh(project.system_size_kw) : null);
  return (
    <div className="space-y-1 text-sm">
      <p className="text-text-primary">Last {snap.points.length} days: {sum.totalKwh} kWh · avg {sum.avgDailyKwh} kWh/day <Pill tone={snap.status === 'online' ? 'success' : 'danger'}>{snap.status}</Pill></p>
      {sum.ratio !== null && <p className={sum.underperforming ? 'text-warning' : 'text-text-secondary'}>{Math.round(sum.ratio * 100)}% of a rule-of-thumb estimate{sum.underperforming ? ' — worth a look' : ''}. Read-only data; estimate is a heuristic, not a guarantee.</p>}
    </div>
  );
}

function JurisdictionManager({ ownerId, canManage }: { ownerId: string; canManage: boolean }) {
  const { toast } = useToast();
  const js = useAsyncData(() => fetchJurisdictions(ownerId), [ownerId], 'Could not load jurisdictions.');
  const blank = { name: '', ahj_name: '', utility_name: '', region: '', notes: '', days: {} as Record<string, string> };
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState(blank);
  const [review, setReview] = useState<{ id: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = (j?: SolarJurisdiction) => {
    setError(null); setEditing(j ? j.id : 'new');
    setForm(j ? { name: j.name, ahj_name: j.ahj_name ?? '', utility_name: j.utility_name ?? '', region: j.region ?? '', notes: j.notes ?? '', days: Object.fromEntries(Object.entries(j.stage_review_days).map(([k, v]) => [k, String(v)])) } : blank);
  };
  const save = async () => {
    const days: Partial<Record<SolarStageKey, number>> = {};
    for (const [k, v] of Object.entries(form.days)) if (v.trim() !== '') days[k as SolarStageKey] = Number(v);
    const problems = validateReviewDays(days);
    if (problems.length) { setError(problems[0]); return; }
    setBusy(true); setError(null);
    try { await saveJurisdiction(ownerId, { ...form, stage_review_days: days }, editing === 'new' ? undefined : (editing as string)); toast('Jurisdiction saved. Any earlier review was cleared.', 'success'); setEditing(null); await js.reload(); }
    catch (e) { setError(friendlySolarError(e)); } finally { setBusy(false); }
  };
  const verify = async () => {
    if (!review) return;
    setBusy(true);
    try { await verifyJurisdiction(ownerId, review.id, review.note); toast('Review recorded', 'success'); setReview(null); await js.reload(); }
    catch (e) { toast(friendlySolarError(e), 'error'); } finally { setBusy(false); }
  };

  if (js.loading) return <Skeleton className="h-32 w-full rounded-2xl" />;
  return (
    <div className="space-y-4">
      <CounselBanner />
      {js.error && <p className="text-sm text-danger" role="alert">{js.error}</p>}
      {canManage && editing === null && <Button onClick={() => open()}>Add jurisdiction profile</Button>}
      {editing !== null && (
        <div className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Profile name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input label="AHJ" value={form.ahj_name} onChange={(e) => setForm({ ...form, ahj_name: e.target.value })} />
            <Input label="Utility" value={form.utility_name} onChange={(e) => setForm({ ...form, utility_name: e.target.value })} />
            <Input label="Region" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
          </div>
          <fieldset className="grid gap-3 sm:grid-cols-5"><legend className="mb-1 text-sm font-medium text-text-primary">Expected review days per stage (your own estimate)</legend>
            {SOLAR_STAGE_KEYS.map((k) => <Input key={k} label={SOLAR_STAGE_LABELS[k]} type="number" min={0} max={365} value={form.days[k] ?? ''} onChange={(e) => setForm({ ...form, days: { ...form.days, [k]: e.target.value } })} />)}
          </fieldset>
          <Textarea label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          <div className="flex gap-2"><Button onClick={save} loading={busy} disabled={!form.name.trim()}>Save</Button><Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>Cancel</Button></div>
        </div>
      )}
      {(js.data ?? []).length === 0 && editing === null ? <p className="text-sm text-text-secondary">No jurisdiction profiles yet. Without one, pipeline due dates are not suggested.</p> : (
        <ul className="space-y-3">
          {(js.data ?? []).map((j) => (
            <li key={j.id} className="rounded-2xl border border-border bg-bg-secondary p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-text-primary">{j.name}</span>
                {jurisdictionNeedsVerification(j) ? <Pill tone="warning">REQUIRES COUNSEL / AHJ verification</Pill> : <Pill tone="success">Reviewed by your team</Pill>}
              </div>
              <p className="text-text-secondary">{[j.ahj_name, j.utility_name, j.region].filter(Boolean).join(' · ') || 'No authority named'}</p>
              {j.verification_note && <p className="text-text-secondary">Review note: {j.verification_note}</p>}
              {canManage && <div className="mt-2 flex gap-2"><Button size="sm" variant="secondary" onClick={() => open(j)}>Edit</Button>{jurisdictionNeedsVerification(j) && <Button size="sm" variant="secondary" onClick={() => setReview({ id: j.id, note: '' })}>Record review</Button>}</div>}
            </li>
          ))}
        </ul>
      )}
      {review && (
        <div className="space-y-3 rounded-2xl border border-accent/40 bg-accent/5 p-4" role="group" aria-label="Record review">
          <Textarea label="Who reviewed this with the AHJ / counsel, and when? (min 5 characters)" value={review.note} onChange={(e) => setReview({ ...review, note: e.target.value })} />
          <div className="flex gap-2"><Button onClick={verify} loading={busy} disabled={review.note.trim().length < 5}>Save review</Button><Button variant="ghost" onClick={() => setReview(null)} disabled={busy}>Cancel</Button></div>
        </div>
      )}
    </div>
  );
}

export function SolarPanel({ ownerId, canManage }: { ownerId: string; canManage: boolean }) {
  const { toast } = useToast();
  const projects = useAsyncData(() => fetchProjects(ownerId), [ownerId], 'Could not load solar projects.');
  const js = useAsyncData(() => fetchJurisdictions(ownerId), [ownerId], 'Could not load jurisdictions.');
  const [tab, setTab] = useState<Tab>('pipeline');
  const [selected, setSelected] = useState<string>('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', site_address: '', system_size_kw: '', jurisdiction_id: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = projects.data ?? [];
  const project = useMemo(() => list.find((p) => p.id === selected) ?? list[0] ?? null, [list, selected]);
  const jurisdiction = (js.data ?? []).find((j) => j.id === project?.jurisdiction_id) ?? null;

  const create = async () => {
    setBusy(true); setError(null);
    try { const id = await createProject(ownerId, form); toast('Project created', 'success'); setAdding(false); setForm({ name: '', site_address: '', system_size_kw: '', jurisdiction_id: '' }); await projects.reload(); setSelected(id); }
    catch (e) { setError(friendlySolarError(e)); } finally { setBusy(false); }
  };
  const patch = async (p: Parameters<typeof updateProject>[2]) => {
    if (!project) return;
    try { await updateProject(ownerId, project.id, p); await projects.reload(); } catch (e) { toast(friendlySolarError(e), 'error'); }
  };

  if (projects.loading) return <Skeleton className="h-48 w-full rounded-2xl" />;
  return (
    <div className="space-y-4">
      {projects.error && <p className="text-sm text-danger" role="alert">{projects.error}</p>}
      <div className="flex flex-wrap items-end gap-3">
        {list.length > 0 && <div className="min-w-[14rem] flex-1"><SelectField label="Project" value={project?.id ?? ''} onChange={setSelected}>{list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField></div>}
        {canManage && !adding && <Button onClick={() => setAdding(true)}>New solar project</Button>}
        {project && canManage && project.status === 'active' && <Button variant="secondary" onClick={() => patch({ status: 'completed' })}>Mark completed</Button>}
      </div>
      {adding && (
        <div className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Project name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input label="Site address" value={form.site_address} onChange={(e) => setForm({ ...form, site_address: e.target.value })} />
            <Input label="System size (kW DC)" type="number" step="any" min={0} value={form.system_size_kw} onChange={(e) => setForm({ ...form, system_size_kw: e.target.value })} />
            <SelectField label="Jurisdiction profile" value={form.jurisdiction_id} onChange={(v) => setForm({ ...form, jurisdiction_id: v })}><option value="">None</option>{(js.data ?? []).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}</SelectField>
          </div>
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          <div className="flex gap-2"><Button onClick={create} loading={busy} disabled={!form.name.trim()}>Create</Button><Button variant="ghost" onClick={() => setAdding(false)} disabled={busy}>Cancel</Button></div>
        </div>
      )}
      <nav className="flex flex-wrap gap-1 border-b border-border" aria-label="Solar sections">
        {TABS.map((t) => <button key={t.key} type="button" onClick={() => setTab(t.key)} aria-current={tab === t.key ? 'page' : undefined} className={`focus-ring -mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t.key ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>{t.label}</button>)}
      </nav>
      {tab === 'jurisdictions' ? <JurisdictionManager ownerId={ownerId} canManage={canManage} /> : !project ? (
        <p className="text-sm text-text-secondary">No solar projects yet.{canManage ? ' Create one to start the permit-to-PTO pipeline.' : ' Ask an owner or admin to create one.'}</p>
      ) : (
        <>
          {jurisdiction && jurisdictionNeedsVerification(jurisdiction) && tab === 'pipeline' && <CounselBanner />}
          {tab === 'pipeline' && <SolarPipelineView ownerId={ownerId} projectId={project.id} jurisdiction={jurisdiction} canManage={canManage} />}
          {tab === 'equipment' && <SolarEquipmentView ownerId={ownerId} projectId={project.id} />}
          {tab === 'claims' && <SolarClaimsView ownerId={ownerId} projectId={project.id} canManage={canManage} />}
          {tab === 'production' && (
            <div className="space-y-3">
              {canManage && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <SelectField label="Monitoring source" value={project.monitoring_provider} onChange={(v) => patch({ monitoring_provider: v as SolarProject['monitoring_provider'] })}>{MONITORING_PROVIDERS.map((p) => <option key={p} value={p}>{p === 'none' ? 'Not connected' : p === 'mock' ? 'Mock (testing)' : p}</option>)}</SelectField>
                  <Input label="Site reference" defaultValue={project.monitoring_site_ref ?? ''} onBlur={(e) => { if ((e.target.value.trim() || null) !== project.monitoring_site_ref) void patch({ monitoring_site_ref: e.target.value.trim() || null }); }} />
                </div>
              )}
              <ProductionCard project={project} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
