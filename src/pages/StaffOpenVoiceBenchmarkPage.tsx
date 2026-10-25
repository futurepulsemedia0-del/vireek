/**
 * Staff console for the Open Voice Benchmark — /staff/open-voice-benchmark (wrap in <StaffRoute>).
 * Reads tables directly (staff-only RLS); every write goes through a staff RPC or the ovb-run function.
 */

import { useCallback, useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { ClipboardCheck } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { newSubmissionToken, ovbRun, staffRpc } from '@/lib/openVoiceBenchmark';
import { DIMENSIONS, DIMENSION_LABELS, validateScenario, type Dimension, type ScenarioDef } from '../../supabase/functions/_shared/ovb/logic';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const TABS = ['runs', 'reviews', 'suites', 'submissions', 'corrections'] as const;
type Tab = (typeof TABS)[number];

function useRows(table: string, select: string, order: string, filter?: (q: any) => any, tick = 0) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    const q = supabase.from(table).select(select).order(order, { ascending: false }).limit(100);
    Promise.resolve(filter ? filter(q) : q).then(({ data, error }: { data: Row[] | null; error: { message: string } | null }) => { if (live) { setRows(data ?? []); setErr(error?.message ?? ''); } });
    return () => { live = false; };
  }, [table, select, order, filter, tick]);
  return { rows, err };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function StaffOpenVoiceBenchmarkPage() {
  const [tab, setTab] = useState<Tab>('runs');
  const [tick, setTick] = useState(0);
  const [msg, setMsg] = useState('');
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const act = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setMsg(`${label}…`);
    try { await fn(); setMsg(`${label}: done`); refresh(); } catch (e) { setMsg(`${label} failed: ${errMsg(e)}`); }
  }, [refresh]);

  return (
    <>
      <Header />
      <main className="bg-bg-primary pt-24">
        <div className="mx-auto max-w-7xl space-y-6 px-6 pb-20">
          <h1 className="pt-6 text-2xl font-bold text-text-primary">Open Voice Benchmark — staff console</h1>
          <nav role="tablist" className="flex flex-wrap gap-2 border-b border-border pb-3">
            {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className={`focus-ring rounded-xl px-4 py-2 text-sm font-medium capitalize ${tab === t ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary'}`}>{t}</button>)}
          </nav>
          {msg && <p role="status" className="text-sm text-text-secondary">{msg}</p>}
          {tab === 'runs' && <Runs tick={tick} act={act} />}
          {tab === 'reviews' && <Reviews tick={tick} act={act} />}
          {tab === 'suites' && <Suites tick={tick} act={act} />}
          {tab === 'submissions' && <Submissions tick={tick} act={act} />}
          {tab === 'corrections' && <Corrections tick={tick} act={act} />}
        </div>
      </main>
      <Footer />
    </>
  );
}

type Act = (label: string, fn: () => Promise<unknown>) => Promise<void>;

function Runs({ tick, act }: { tick: number; act: Act }) {
  const { rows } = useRows('ovb_runs', 'id,status,visibility,purpose,provenance,channel,agent_version,scores,started_at,scenario_count,agent:ovb_agents(slug,display_name),suite:ovb_suites(version)', 'started_at', undefined, tick);
  const { rows: agents } = useRows('ovb_agents', 'slug,display_name,interface_kind,listing_status', 'created_at', undefined, tick);
  const [f, setF] = useState({ agent: 'vireek', purpose: 'certification', heldOut: true, version: '', secret: '' });
  const [progress, setProgress] = useState('');

  const drive = (first: Record<string, unknown> | null, runId?: string) => act('Run', async () => {
    let r = first ? await ovbRun(first) : await ovbRun({ action: 'continue', run_id: runId, vendor_secret: f.secret || undefined });
    for (let i = 0; i < 60 && Number(r.remaining) > 0; i++) {
      setProgress(`${r.remaining} scenario(s) remaining…`);
      if (r.status !== 'running') break;
      r = await ovbRun({ action: 'continue', run_id: r.runId, vendor_secret: f.secret || undefined });
    }
    setProgress(Number(r.remaining) > 0 ? `${r.remaining} remaining (awaiting phone calls or deferred by business hours; use Continue later)` : 'Finished');
  });

  return (
    <div className="space-y-6">
      <Card className="space-y-3 !p-6"><h2 className="font-semibold text-text-primary">Start a run</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm">Agent<select value={f.agent} onChange={(e) => setF({ ...f, agent: e.target.value })} className="focus-ring mt-1.5 w-full rounded-xl border border-border bg-bg-primary px-3 py-3">{(agents ?? []).map((a) => <option key={a.slug} value={a.slug}>{a.display_name} ({a.interface_kind})</option>)}</select></label>
          <label className="text-sm">Purpose<select value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} className="focus-ring mt-1.5 w-full rounded-xl border border-border bg-bg-primary px-3 py-3"><option value="certification">certification (publishable)</option><option value="regression">regression (private)</option></select></label>
          <Input label="Agent version" value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} helperText="Vireek build, git SHA or vendor version" />
          <Input label="Vendor API secret (not stored)" type="password" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} autoComplete="off" />
          <label className="flex items-center gap-2 pt-7 text-sm"><input type="checkbox" checked={f.heldOut} onChange={(e) => setF({ ...f, heldOut: e.target.checked })} /> include held-out scenarios</label>
        </div>
        <div className="flex items-center gap-3"><Button onClick={() => void drive({ action: 'start', agent_slug: f.agent, purpose: f.purpose, include_held_out: f.heldOut, agent_version: f.version || undefined, vendor_secret: f.secret || undefined })}>Start and process</Button>{progress && <span className="text-sm text-text-secondary">{progress}</span>}</div>
      </Card>
      {rows === null ? <Skeleton className="h-40 w-full" /> : rows.length === 0 ? <EmptyState icon={ClipboardCheck} title="Runs will be listed here" /> : (
        <div className="overflow-x-auto rounded-2xl border border-border"><table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-bg-tertiary/60 text-xs uppercase text-text-secondary"><tr><th className="p-3">Agent</th><th>Suite</th><th>Purpose</th><th>Status</th><th>Overall</th><th>Pending reviews</th><th>Visibility</th><th /></tr></thead>
          <tbody className="divide-y divide-border">{rows.map((r) => (
            <tr key={r.id}><td className="p-3">{r.agent?.display_name}<div className="text-xs text-text-secondary">{r.agent_version} · {r.provenance}</div></td><td>v{r.suite?.version}</td><td>{r.purpose}</td><td>{r.status}</td><td className="tabular-nums">{r.scores?.overall?.score ?? '—'}</td><td className="tabular-nums">{r.scores?.pending_reviews ?? 0}</td><td>{r.visibility}</td>
              <td className="space-x-1 p-2 text-right">
                {r.visibility === 'private' && r.status === 'running' && <Button size="sm" variant="secondary" onClick={() => void drive(null, r.id)}>Continue</Button>}
                {r.visibility === 'private' && r.status !== 'running' && <Button size="sm" variant="secondary" onClick={() => void act('Finalize', () => ovbRun({ action: 'finalize', run_id: r.id }))}>Re-score</Button>}
                {r.visibility === 'private' && r.status === 'completed' && r.purpose === 'certification' && <Button size="sm" onClick={() => void act('Publish', () => staffRpc('ovb_staff_set_run_visibility', { p_run: r.id, p_visibility: 'public' }))}>Publish</Button>}
              </td></tr>))}</tbody></table></div>
      )}
      <p className="text-xs text-text-secondary">Publishing is blocked by the database unless the run is completed, certification, fully reviewed, hash-chain intact and the agent is listed. Retract a published run from the Corrections tab.</p>
    </div>
  );
}

function Reviews({ tick, act }: { tick: number; act: Act }) {
  const filter = useCallback((q: any) => q.eq('status', 'needs_review'), []); // eslint-disable-line @typescript-eslint/no-explicit-any
  const { rows } = useRows('ovb_run_results', 'id,run_id,final_score,review_flags,transcript,check_results,auto_scores,outcome,outcome_source,is_held_out,scenario:ovb_scenarios(scenario_key,title,category)', 'created_at', filter, tick);
  const [sel, setSel] = useState<string | null>(null);
  const [scores, setScores] = useState<Partial<Record<Dimension, string>>>({});
  const [critical, setCritical] = useState<boolean | null>(null);
  const [notes, setNotes] = useState('');
  if (rows === null) return <Skeleton className="h-40 w-full" />;
  if (!rows.length) return <EmptyState icon={ClipboardCheck} title="Review queue is clear" description="Flagged results from certification runs appear here." />;
  const r = rows.find((x) => x.id === sel);
  const submit = (verdict: 'confirm' | 'override') => act('Review', async () => {
    const dims: Record<string, number> = {};
    for (const d of DIMENSIONS) if (scores[d] !== undefined && scores[d] !== '') dims[d] = Number(scores[d]);
    await staffRpc('ovb_staff_submit_review', { p_result: r!.id, p_verdict: verdict, p_scores: verdict === 'override' ? dims : null, p_critical: verdict === 'override' ? critical : null, p_notes: notes });
    await ovbRun({ action: 'finalize', run_id: r!.run_id });
    setSel(null); setScores({}); setCritical(null); setNotes('');
  });
  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <ul className="space-y-2">{rows.map((x) => <li key={x.id}><button type="button" onClick={() => setSel(x.id)} className={`focus-ring w-full rounded-xl border p-3 text-left text-sm ${sel === x.id ? 'border-accent bg-accent/10' : 'border-border'}`}><div className="font-medium text-text-primary">{x.is_held_out ? 'Held-out scenario' : x.scenario?.title}</div><div className="text-xs text-text-secondary">score {x.final_score} · {(x.review_flags ?? []).join(', ')}</div></button></li>)}</ul>
      {r ? (
        <Card className="space-y-4 !p-6">
          <h2 className="font-semibold text-text-primary">{r.scenario?.title} <span className="text-xs text-text-secondary">({r.scenario?.scenario_key})</span></h2>
          <ol className="space-y-1.5 text-sm">{(r.transcript ?? []).map((t: Row, i: number) => <li key={i}><b className={t.role === 'agent' ? 'text-accent' : 'text-text-secondary'}>{t.role}:</b> {t.text}</li>)}</ol>
          <ul className="grid gap-1 text-xs sm:grid-cols-2">{(r.check_results ?? []).map((c: Row) => <li key={c.id} className={c.passed ? 'text-success' : 'text-danger'}>{c.passed ? '✓' : '✗'} {c.dimension} · {c.id}{c.critical ? ' (critical)' : ''} — <span className="text-text-secondary">{c.detail}</span></li>)}</ul>
          <p className="text-xs text-text-secondary">Outcome: {r.outcome ?? 'unknown'} ({r.outcome_source ?? 'none'}). Automated dimensions: {JSON.stringify(r.auto_scores?.dimensions)}</p>
          <div className="grid gap-3 sm:grid-cols-5">{DIMENSIONS.map((d) => <Input key={d} label={DIMENSION_LABELS[d].split(' ')[0]} inputMode="decimal" placeholder={String(r.auto_scores?.dimensions?.[d] ?? '')} value={scores[d] ?? ''} onChange={(e) => setScores({ ...scores, [d]: e.target.value })} />)}</div>
          <div className="flex flex-wrap items-center gap-4 text-sm"><span>Critical failure:</span>{([['keep', null], ['yes', true], ['no', false]] as const).map(([l, v]) => <label key={l} className="flex items-center gap-1.5"><input type="radio" name="crit" checked={critical === v} onChange={() => setCritical(v)} />{l}</label>)}</div>
          <Textarea label="Reasoning (required for overrides)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="flex gap-2"><Button onClick={() => void submit('confirm')}>Confirm automated score</Button><Button variant="secondary" onClick={() => void submit('override')}>Override with my scores</Button></div>
        </Card>
      ) : <EmptyState icon={ClipboardCheck} title="Select a result to review" />}
    </div>
  );
}

function Suites({ tick, act }: { tick: number; act: Act }) {
  const { rows } = useRows('ovb_suites', 'id,version,title,status,held_out_count,published_at,eval_suite_id,public_manifest_hash', 'created_at', undefined, tick);
  const [create, setCreate] = useState({ version: '', title: '', changelog: '' });
  const [imp, setImp] = useState({ version: '', json: '' });
  const [account, setAccount] = useState('');
  const importJson = () => act('Import', async () => {
    const items = JSON.parse(imp.json) as ScenarioDef[];
    if (!Array.isArray(items)) throw new Error('Expected a JSON array');
    const problems = items.flatMap(validateScenario);
    if (problems.length) throw new Error(problems.slice(0, 5).join('; '));
    return staffRpc('ovb_staff_import_scenarios', { p_version: imp.version, p_items: items });
  });
  return (
    <div className="space-y-6">
      {rows === null ? <Skeleton className="h-32 w-full" /> : (
        <div className="overflow-x-auto rounded-2xl border border-border"><table className="w-full min-w-[720px] text-left text-sm"><thead className="bg-bg-tertiary/60 text-xs uppercase text-text-secondary"><tr><th className="p-3">Version</th><th>Status</th><th>Held-out</th><th>Eval mirror</th><th /></tr></thead>
          <tbody className="divide-y divide-border">{rows.map((s) => <tr key={s.id}><td className="p-3">v{s.version}<div className="text-xs text-text-secondary">{s.title}</div></td><td>{s.status}</td><td>{s.held_out_count}</td><td>{s.eval_suite_id ? 'yes' : '—'}</td>
            <td className="space-x-1 p-2 text-right">
              {s.status === 'draft' && <Button size="sm" onClick={() => void act('Publish suite', () => staffRpc('ovb_staff_publish_suite', { p_version: s.version }))}>Publish</Button>}
              {s.status === 'published' && <Button size="sm" variant="secondary" onClick={() => { if (window.confirm('Retire this suite and reveal the held-out scenarios? This cannot be undone.')) void act('Retire suite', () => staffRpc('ovb_staff_retire_suite', { p_version: s.version, p_reveal: true })); }}>Retire + reveal</Button>}
              {s.status !== 'draft' && !s.eval_suite_id && <Button size="sm" variant="ghost" onClick={() => void act('Mirror', () => ovbRun({ action: 'sync_mirror', suite_version: s.version, account_id: account || undefined }))}>Mirror to eval plane</Button>}
            </td></tr>)}</tbody></table></div>
      )}
      <Input label="Eval-plane owner account id (optional, defaults to you)" value={account} onChange={(e) => setAccount(e.target.value)} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3 !p-6"><h2 className="font-semibold text-text-primary">New draft version</h2>
          <Input label="Version (x.y.z)" value={create.version} onChange={(e) => setCreate({ ...create, version: e.target.value })} />
          <Input label="Title" value={create.title} onChange={(e) => setCreate({ ...create, title: e.target.value })} />
          <Textarea label="Changelog" value={create.changelog} onChange={(e) => setCreate({ ...create, changelog: e.target.value })} />
          <Button onClick={() => void act('Create suite', () => staffRpc('ovb_staff_create_suite', { p_version: create.version, p_title: create.title, p_changelog: create.changelog, p_copy_from: null }))}>Create</Button></Card>
        <Card className="space-y-3 !p-6"><h2 className="font-semibold text-text-primary">Import scenarios (JSON array, draft suites only)</h2>
          <Input label="Suite version" value={imp.version} onChange={(e) => setImp({ ...imp, version: e.target.value })} />
          <Textarea label="Scenarios JSON" rows={8} value={imp.json} onChange={(e) => setImp({ ...imp, json: e.target.value })} helperText="Held-out scenarios: set is_held_out true. Never commit them to git." />
          <Button onClick={() => void importJson()}>Validate and import</Button></Card>
      </div>
    </div>
  );
}

function Submissions({ tick, act }: { tick: number; act: Act }) {
  const { rows } = useRows('ovb_submissions', 'id,org_name,contact_name,contact_email,agent_name,agent_version,interface_kind,phone_number,api_base_url,wants_independent_run,wants_bundle,public_listing_consent,status,token_prefix,created_at,agent_id', 'created_at', undefined, tick);
  const [token, setToken] = useState('');
  const approve = (id: string) => act('Approve', async () => {
    const t = await newSubmissionToken();
    await staffRpc('ovb_staff_decide_submission', { p_id: id, p_decision: 'approve', p_note: '', p_token_hash: t.hash, p_token_prefix: t.prefix });
    setToken(t.token);
  });
  if (rows === null) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="space-y-4">
      {token && <Card className="!p-5"><p className="text-sm text-text-primary">Submission token (shown once, send it to the vendor over a secure channel):</p><p className="mt-2 break-all font-mono text-sm">{token}</p></Card>}
      {rows.length === 0 ? <EmptyState icon={ClipboardCheck} title="Vendor submissions will be listed here" /> : rows.map((s) => (
        <Card key={s.id} className="space-y-1 !p-5 text-sm"><div className="font-medium text-text-primary">{s.org_name} — {s.agent_name} {s.agent_version} <span className="text-xs text-text-secondary">({s.status})</span></div>
          <div className="text-text-secondary">{s.contact_name} · {s.contact_email} · {s.interface_kind} {s.phone_number ?? s.api_base_url ?? ''} · independent: {String(s.wants_independent_run)} · bundle: {String(s.wants_bundle)} · public consent: {String(s.public_listing_consent)}</div>
          {s.status === 'pending' && <div className="flex gap-2 pt-2"><Button size="sm" onClick={() => void approve(s.id)}>Approve + issue token</Button><Button size="sm" variant="secondary" onClick={() => void act('Reject', () => staffRpc('ovb_staff_decide_submission', { p_id: s.id, p_decision: 'reject', p_note: '' }))}>Reject</Button></div>}
          {s.agent_id && <div className="flex gap-2 pt-2">{(['listed', 'delisted'] as const).map((st) => <Button key={st} size="sm" variant="ghost" onClick={() => void act('Listing', () => staffRpc('ovb_staff_set_agent_listing', { p_agent: s.agent_id, p_status: st }))}>{st === 'listed' ? 'List publicly' : 'Delist (withdrawal)'}</Button>)}</div>}
        </Card>))}
    </div>
  );
}

function Corrections({ tick, act }: { tick: number; act: Act }) {
  const { rows: reqs } = useRows('ovb_correction_requests', 'id,requester_name,requester_email,requester_org,run_id,message,status,created_at', 'created_at', undefined, tick);
  const [f, setF] = useState({ kind: 'clarification', title: '', body: '', version: '', run: '', request: '' });
  const add = () => act('Publish correction', async () => {
    const id = await staffRpc<string>('ovb_staff_add_correction', { p_kind: f.kind, p_title: f.title, p_body: f.body, p_suite_version: f.version || null, p_run: f.run || null, p_supersedes: null, p_request: f.request || null });
    if (f.kind === 'retraction' && f.run) await staffRpc('ovb_staff_set_run_visibility', { p_run: f.run, p_visibility: 'retracted', p_correction: id });
  });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="space-y-3 !p-6"><h2 className="font-semibold text-text-primary">Publish a correction</h2>
        <label className="text-sm">Kind<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className="focus-ring mt-1.5 w-full rounded-xl border border-border bg-bg-primary px-3 py-3">{['clarification', 'error', 'methodology', 'scenario_fix', 'retraction'].map((k) => <option key={k}>{k}</option>)}</select></label>
        <Input label="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <Textarea label="Body (public, append-only)" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        <Input label="Suite version (optional)" value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} />
        <Input label={f.kind === 'retraction' ? 'Run id to retract (required)' : 'Run id (optional)'} value={f.run} onChange={(e) => setF({ ...f, run: e.target.value })} />
        <Input label="Resolves request id (optional)" value={f.request} onChange={(e) => setF({ ...f, request: e.target.value })} />
        <Button onClick={() => { if (f.kind !== 'retraction' || window.confirm('This retracts the published run permanently.')) void add(); }}>Publish</Button>
      </Card>
      <div className="space-y-3">{reqs === null ? <Skeleton className="h-32 w-full" /> : reqs.length === 0 ? <EmptyState icon={ClipboardCheck} title="Correction requests will be listed here" /> : reqs.map((r) => (
        <Card key={r.id} className="space-y-1 !p-5 text-sm"><div className="font-medium text-text-primary">{r.requester_name} {r.requester_org ? `(${r.requester_org})` : ''} <span className="text-xs text-text-secondary">· {r.status} · {new Date(r.created_at).toLocaleDateString()}</span></div>
          <div className="text-text-secondary">{r.requester_email}{r.run_id ? ` · run ${r.run_id}` : ''}</div><p>{r.message}</p><p className="font-mono text-[11px] text-text-secondary">{r.id}</p>
          {r.status === 'open' && <div className="flex gap-2 pt-1"><Button size="sm" variant="secondary" onClick={() => void act('Acknowledge', () => staffRpc('ovb_staff_update_correction_request', { p_id: r.id, p_status: 'acknowledged' }))}>Acknowledge</Button><Button size="sm" variant="ghost" onClick={() => void act('Decline', () => staffRpc('ovb_staff_update_correction_request', { p_id: r.id, p_status: 'declined' }))}>Decline</Button></div>}
        </Card>))}</div>
    </div>
  );
}
