/**
 * Workflow Compiler — /dashboard/workflow-compiler
 *
 * The owner says what should happen. Vireek compiles it into a validated,
 * frozen execution graph; the owner reviews the pipeline + risk report, tries
 * it in test mode against a sample event, and only then promotes it to live.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Archive, CheckCircle2, ChevronDown, ChevronUp, Clock, Fingerprint, FlaskConical, Loader2, Pause, Play,
  RefreshCw, Rocket, ShieldCheck, Sparkles, Wand2, Workflow as WorkflowIcon, XCircle,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  CompileError, EXAMPLE_INSTRUCTIONS, KIND_LABEL, NODE_H, NODE_W, RUN_STATUS_LABEL, RUN_STATUS_STYLE, STATUS_LABEL, STATUS_STYLE, TRIGGER_LABEL,
  cancelCompiledRun, compileWorkflow, decideCompiledApproval, fetchCompiledRuns, fetchCompiledWorkflows, fetchPendingCompiledApprovals,
  fetchRunAudit, formatCents, layoutGraph, setCompiledWorkflowStatus, startTestRun, verifyAuditChain,
} from '@/lib/workflowCompiler';
import type { AuditEvent, CompiledApproval, CompiledRun, CompiledWorkflow, NodeKind } from '@/lib/workflowCompiler';

type TabKey = 'compile' | 'workflows' | 'runs' | 'approvals';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'compile', label: 'Compile' },
  { key: 'workflows', label: 'My Compiled Workflows' },
  { key: 'runs', label: 'Runs & Audit' },
  { key: 'approvals', label: 'Approvals' },
];

const KIND_STROKE: Record<NodeKind, string> = {
  lookup: 'stroke-accent-500', reason: 'stroke-accent-500', decision: 'stroke-warning-500', action: 'stroke-success-500',
  approval: 'stroke-warning-500', verify: 'stroke-accent-500', wait: 'stroke-border',
};

const btn = 'focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary disabled:opacity-50';
const btnPrimary = 'focus-ring inline-flex items-center gap-1.5 rounded-lg bg-accent-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-600 disabled:opacity-50';

// ============================================================
// Pipeline strip + graph
// ============================================================

function PipelineStrip({ wf }: { wf: CompiledWorkflow }) {
  const s = wf.report.stages;
  const stages: [string, number][] = [
    ['Trigger', s.trigger], ['Conditions', s.conditions], ['AI reasoning', s.reasoning], ['Data lookup', s.lookups], ['Decision', s.decisions],
    ['Agent actions', s.actions], ['Human approval', s.approvals], ['Fallback', s.fallbacks], ['Verification', s.verifications], ['Audit', s.audit],
  ];
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label="Compiled pipeline">
      {stages.map(([label, n], i) => (
        <li key={label} className="flex items-center gap-1.5">
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${n > 0 ? 'bg-accent-500/10 text-accent-500' : 'bg-bg-tertiary text-text-secondary'}`}>
            {label}{n > 1 || (n === 1 && label !== 'Trigger' && label !== 'Audit') ? ` · ${n}` : ''}
          </span>
          {i < stages.length - 1 && <span aria-hidden className="text-text-secondary">→</span>}
        </li>
      ))}
    </ol>
  );
}

function GraphView({ wf }: { wf: CompiledWorkflow }) {
  const layout = useMemo(() => layoutGraph(wf.graph), [wf.graph]);
  const pad = 12;
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-bg-primary p-3">
      <svg
        role="img"
        aria-label={`Execution graph for ${wf.name}`}
        viewBox={`${-pad} ${-pad} ${layout.width + pad * 2} ${layout.height + pad * 2}`}
        style={{ minWidth: Math.min(layout.width + pad * 2, 720), width: '100%', maxHeight: 900 }}
      >
        {layout.edges.map((e) => (
          <g key={`${e.from}-${e.on}-${e.to}`}>
            <path d={e.d} fill="none" strokeWidth={1.5} className={e.on === 'fail' || e.on === 'timeout' || e.on === 'rejected' ? 'stroke-danger' : 'stroke-border'} strokeDasharray={e.on === 'fail' || e.on === 'timeout' ? '5 4' : undefined} />
            {e.on !== 'next' && <text x={e.lx} y={e.ly - 3} textAnchor="middle" className="fill-text-secondary" fontSize={10}>{e.on}</text>}
          </g>
        ))}
        {layout.nodes.map((n) => (
          <g key={n.id} transform={`translate(${n.x},${n.y})`}>
            <rect width={NODE_W} height={NODE_H} rx={10} strokeWidth={n.node.auto ? 1 : 1.75} strokeDasharray={n.node.auto ? '4 3' : undefined} className={`fill-bg-secondary ${KIND_STROKE[n.node.kind]}`} />
            <text x={10} y={19} fontSize={10} className="fill-text-secondary">{KIND_LABEL[n.node.kind]}{n.node.auto ? ' · auto' : ''}</text>
            <text x={10} y={39} fontSize={12} fontWeight={600} className="fill-text-primary">{n.node.label.length > 24 ? `${n.node.label.slice(0, 23)}…` : n.node.label}</text>
            <title>{n.node.label}</title>
          </g>
        ))}
      </svg>
    </div>
  );
}

function ReportPanel({ wf }: { wf: CompiledWorkflow }) {
  const r = wf.report;
  const [showPaths, setShowPaths] = useState(false);
  const label = (id: string) => wf.graph.nodes[id]?.label ?? id;
  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="inline-flex items-center gap-1 rounded-full bg-success-500/10 px-2.5 py-1 font-medium text-success-500"><ShieldCheck size={13} /> Validated by the compiler</span>
        <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-text-secondary">{r.node_count} steps</span>
        <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-text-secondary">{r.approvals} human approval{r.approvals === 1 ? '' : 's'}</span>
        <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-text-secondary">{r.commitment_actions} commitment action{r.commitment_actions === 1 ? '' : 's'} (all approval-gated)</span>
        <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-text-secondary">{r.has_sla ? `${wf.sla_minutes} min time limit` : 'No time limit'}</span>
        <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-text-secondary">{r.paths.length}{r.paths_truncated ? '+' : ''} possible path{r.paths.length === 1 ? '' : 's'}</span>
      </div>
      {r.warnings.map((w) => <p key={w} className="text-xs text-warning-500">⚠ {w}</p>)}
      {(wf.ir.assumptions?.length ?? 0) > 0 && (
        <div>
          <p className="text-xs font-medium text-text-primary">Assumptions Vireek made</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-text-secondary">{wf.ir.assumptions!.map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      )}
      <button type="button" onClick={() => setShowPaths((v) => !v)} className="focus-ring flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-text-primary">
        {showPaths ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Every path this workflow can take
      </button>
      {showPaths && (
        <ol className="space-y-1.5">
          {r.paths.map((p, i) => <li key={i} className="text-xs text-text-secondary"><span className="font-medium text-text-primary">{i + 1}.</span> {p.map(label).join(' → ')}</li>)}
        </ol>
      )}
    </div>
  );
}

// ============================================================
// Workflow detail + lifecycle actions
// ============================================================

function SampleEventForm({ wf, onStarted }: { wf: CompiledWorkflow; onStarted: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState('Sample Customer');
  const [phone, setPhone] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      await startTestRun(wf.id, { summary: summary.trim(), is_emergency: wf.trigger_event === 'call.emergency', caller_name: name.trim() }, name.trim(), phone.trim());
      toast('Test run started — watch it under Runs & Audit. Actions are simulated; lookups and AI reasoning are real.', 'success');
      onStarted();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the test run.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const field = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
  return (
    <div className="space-y-2 rounded-xl border border-border bg-bg-primary p-4">
      <p className="text-sm font-medium text-text-primary">Run a sample {TRIGGER_LABEL[wf.trigger_event]?.toLowerCase() ?? 'event'}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer name" aria-label="Customer name" maxLength={80} />
        <input className={field} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Customer phone (use a real one to test VIP lookup)" aria-label="Customer phone" maxLength={24} />
      </div>
      <textarea className={field} dir="auto" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What the customer said (call summary), e.g. “AC stopped, 38°C inside, compressor humming”" aria-label="Call summary" maxLength={1500} />
      <button type="button" disabled={busy} onClick={start} className={btnPrimary}>{busy ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />} Start test run</button>
    </div>
  );
}

function WorkflowDetail({ wf, onChanged, onGoRuns }: { wf: CompiledWorkflow; onChanged: () => void; onGoRuns: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [showSample, setShowSample] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);

  const move = async (status: 'test' | 'live' | 'paused' | 'archived', okMsg: string) => {
    setBusy(true);
    try {
      await setCompiledWorkflowStatus(wf.id, status);
      toast(okMsg, 'success');
      setConfirmLive(false);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the workflow.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-text-primary" dir="auto">{wf.name}</h3>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[wf.status]}`}>{STATUS_LABEL[wf.status]}</span>
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">Trigger: {TRIGGER_LABEL[wf.trigger_event] ?? wf.trigger_event}</span>
          </div>
          <p className="mt-1 text-sm text-text-secondary" dir="auto">{wf.summary}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {wf.status === 'draft' && <button type="button" disabled={busy} onClick={() => move('test', 'Started in test mode — it now reacts to real events with simulated actions.')} className={btnPrimary}><FlaskConical size={14} /> Start in test mode</button>}
          {(wf.status === 'test' || wf.status === 'paused') && <button type="button" onClick={() => setShowSample((v) => !v)} className={btn}><Play size={14} /> Run sample event</button>}
          {wf.status === 'test' && (confirmLive
            ? <><button type="button" disabled={busy} onClick={() => move('live', 'Live — approved actions will now really happen.')} className={btnPrimary}><Rocket size={14} /> Yes, go live</button><button type="button" onClick={() => setConfirmLive(false)} className={btn}>Cancel</button></>
            : <button type="button" onClick={() => setConfirmLive(true)} className={btn}><Rocket size={14} /> Promote to live</button>)}
          {wf.status === 'paused' && <button type="button" disabled={busy} onClick={() => move('test', 'Resumed in test mode.')} className={btn}><FlaskConical size={14} /> Resume in test</button>}
          {wf.status === 'live' && <button type="button" disabled={busy} onClick={() => move('test', 'Back in test mode — actions are simulated again.')} className={btn}><FlaskConical size={14} /> Back to test</button>}
          {(wf.status === 'live' || wf.status === 'test') && <button type="button" disabled={busy} onClick={() => move('paused', 'Paused — no new events will start runs.')} className={btn}><Pause size={14} /> Pause</button>}
          {wf.status !== 'archived' && <button type="button" disabled={busy} onClick={() => move('archived', wf.status === 'draft' ? 'Draft discarded.' : 'Archived.')} className={btn}><Archive size={14} /> {wf.status === 'draft' ? 'Discard' : 'Archive'}</button>}
        </div>
      </div>
      {confirmLive && <p className="text-xs text-warning-500">Going live means approved dispatches, contractor posts and customer texts really happen. You will still be asked to approve the price before any commitment.</p>}
      {showSample && <SampleEventForm wf={wf} onStarted={() => { setShowSample(false); onChanged(); onGoRuns(); }} />}
      <PipelineStrip wf={wf} />
      <GraphView wf={wf} />
      <ReportPanel wf={wf} />
      <p className="text-xs text-text-secondary" dir="auto">Original request: “{wf.instruction}”</p>
    </div>
  );
}

// ============================================================
// Tabs
// ============================================================

function CompileTab({ onCompiled, onChanged, onGoRuns, latest }: { onCompiled: (wf: CompiledWorkflow) => void; onChanged: () => void; onGoRuns: () => void; latest: CompiledWorkflow | null }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CompileError | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || text.trim().length < 15) return;
    setBusy(true);
    setError(null);
    try {
      const { workflow } = await compileWorkflow(text.trim());
      onCompiled(workflow);
    } catch (err) {
      setError(err instanceof CompileError ? err : new CompileError(err instanceof Error ? err.message : 'Compile failed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-5">
        <label htmlFor="wc-instruction" className="flex items-center gap-2 text-sm font-medium text-text-primary"><Wand2 size={16} /> What should happen?</label>
        <textarea
          id="wc-instruction" dir="auto" rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000}
          placeholder="Describe the situation, the conditions, and the outcome you want — in your own words, in any language."
          className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-sm text-text-primary"
        />
        <div className="flex flex-wrap items-center gap-2">
          {EXAMPLE_INSTRUCTIONS.map((ex) => <button key={ex.label} type="button" onClick={() => setText(ex.text)} className="focus-ring rounded-full border border-border px-3 py-1 text-xs text-text-secondary hover:text-text-primary">{ex.label}</button>)}
          <span className="ml-auto text-xs text-text-secondary">{text.length}/2000</span>
          <button type="submit" disabled={busy || text.trim().length < 15} className={btnPrimary}>
            {busy ? <><Loader2 size={14} className="animate-spin" /> Compiling…</> : <><Sparkles size={14} /> Compile workflow</>}
          </button>
        </div>
        {error && (
          <div role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
            <p className="font-medium">{error.message}</p>
            {error.details.length > 0 && <ul className="mt-1 list-disc pl-5 opacity-80">{error.details.slice(0, 4).map((d) => <li key={d}>{d}</li>)}</ul>}
          </div>
        )}
      </form>
      {latest && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-border bg-bg-secondary p-5">
          <WorkflowDetail wf={latest} onChanged={onChanged} onGoRuns={onGoRuns} />
        </motion.div>
      )}
    </div>
  );
}

function WorkflowsTab({ workflows, onChanged, onGoRuns }: { workflows: CompiledWorkflow[]; onChanged: () => void; onGoRuns: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (workflows.length === 0) return <p className="py-12 text-center text-sm text-text-secondary">Nothing compiled yet. Describe a situation in the Compile tab.</p>;
  return (
    <div className="space-y-3">
      {workflows.map((wf) => (
        <div key={wf.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
          <button type="button" onClick={() => setOpenId(openId === wf.id ? null : wf.id)} className="focus-ring flex w-full items-center justify-between gap-3 text-left" aria-expanded={openId === wf.id}>
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-text-primary" dir="auto">{wf.name}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[wf.status]}`}>{STATUS_LABEL[wf.status]}</span>
              </span>
              <span className="block truncate text-xs text-text-secondary" dir="auto">{TRIGGER_LABEL[wf.trigger_event] ?? wf.trigger_event} · {wf.report.node_count} steps · {new Date(wf.created_at).toLocaleDateString()}</span>
            </span>
            {openId === wf.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {openId === wf.id && <div className="mt-4 border-t border-border pt-4"><WorkflowDetail wf={wf} onChanged={onChanged} onGoRuns={onGoRuns} /></div>}
        </div>
      ))}
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  run_started: 'Run started', node_started: 'Step started', node_completed: 'Step completed', node_failed: 'Step failed', edge_taken: 'Branch taken',
  approval_requested: 'Approval requested', approval_decided: 'Approval decided', approval_expired: 'Approval timed out', timer_set: 'Waiting',
  sla_breached: 'Time limit exceeded', action_outcome_unknown: 'Outcome unknown (not repeated)', run_completed: 'Run completed', run_failed: 'Run failed',
  run_cancelled: 'Run cancelled', engine_error: 'Engine error',
};

function detailLine(e: AuditEvent): string {
  const d = e.detail as Record<string, unknown>;
  const parts: string[] = [];
  if (d.edge) parts.push(`→ ${String(d.edge)}`);
  if (d.error) parts.push(`error: ${String(d.error)}`);
  if (d.prompt) parts.push(String(d.prompt));
  if (d.decision) parts.push(`${String(d.decision)}${d.price_cents != null ? ` at ${formatCents(Number(d.price_cents))}` : ''}`);
  if (d.reason) parts.push(String(d.reason));
  if (d.mode) parts.push(`${String(d.mode)} mode`);
  const out = d.output as Record<string, unknown> | null | undefined;
  if (out && typeof out === 'object') {
    const keys = Object.keys(out).slice(0, 4);
    if (keys.length) parts.push(keys.map((k) => `${k}: ${String(out[k]).slice(0, 60)}`).join(' · '));
  }
  return parts.join(' — ');
}

function RunRow({ run, wf, onChanged }: { run: CompiledRun; wf?: CompiledWorkflow; onChanged: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [chain, setChain] = useState<{ ok: boolean; checked: number; first_bad_seq: number | null } | null>(null);
  const active = run.status === 'active' || run.status === 'waiting_approval' || run.status === 'waiting_timer';
  const label = (id: string | null) => (id ? wf?.graph.nodes[id]?.label ?? id : '');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () => fetchRunAudit(run.id).then((d) => { if (!cancelled) setEvents(d); }).catch(() => {});
    load();
    const t = active ? window.setInterval(load, 8000) : undefined;
    return () => { cancelled = true; if (t) window.clearInterval(t); };
  }, [open, run.id, active, run.status]);

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <button type="button" onClick={() => setOpen((v) => !v)} className="focus-ring flex w-full items-center justify-between gap-3 text-left" aria-expanded={open}>
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text-primary" dir="auto">{wf?.name ?? 'Workflow'}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RUN_STATUS_STYLE[run.status]}`}>{RUN_STATUS_LABEL[run.status]}</span>
            {run.mode === 'test' && <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-xs text-warning-500">Test</span>}
            {run.sla_breached_at && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs text-danger">Over time limit</span>}
          </span>
          <span className="block truncate text-xs text-text-secondary">{run.customer_name ?? 'Unknown customer'} · started {new Date(run.started_at).toLocaleString()}{run.stop_reason ? ` · ${run.stop_reason}` : ''}</span>
        </span>
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {open && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btn} onClick={async () => { try { setChain(await verifyAuditChain(run.id)); } catch (e) { toast(e instanceof Error ? e.message : 'Verification failed', 'error'); } }}>
              <Fingerprint size={14} /> Verify audit integrity
            </button>
            {active && <button type="button" className={btn} onClick={async () => { if (await cancelCompiledRun(run.id)) { toast('Run cancelled.', 'success'); onChanged(); } else toast('Could not cancel this run.', 'error'); }}><XCircle size={14} /> Cancel run</button>}
            {chain && <span className={`inline-flex items-center gap-1 text-xs font-medium ${chain.ok ? 'text-success-500' : 'text-danger'}`}>{chain.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}{chain.ok ? `Intact — ${chain.checked} entries verified` : `Tampering detected at entry ${chain.first_bad_seq}`}</span>}
          </div>
          {events === null ? <Loader2 size={18} className="animate-spin text-text-secondary" /> : (
            <ol className="space-y-1.5">
              {events.filter((e) => e.event_type !== 'node_started').map((e) => (
                <li key={e.id} className="flex gap-3 text-xs">
                  <span className="w-20 shrink-0 text-text-secondary">{new Date(e.created_at).toLocaleTimeString()}</span>
                  <span className="min-w-0 text-text-secondary">
                    <span className={`font-medium ${e.event_type.includes('fail') || e.event_type === 'engine_error' || e.event_type === 'sla_breached' ? 'text-danger' : 'text-text-primary'}`}>{EVENT_LABEL[e.event_type] ?? e.event_type}</span>
                    {e.node_id ? ` · ${label(e.node_id)}` : ''}
                    {detailLine(e) ? <span className="block break-words" dir="auto">{detailLine(e)}</span> : null}
                    <span className="block font-mono text-[10px] opacity-50">#{e.seq} {e.hash.slice(0, 10)}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ a, wf, onChanged }: { a: CompiledApproval; wf?: CompiledWorkflow; onChanged: () => void }) {
  const { toast } = useToast();
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const decide = async (approve: boolean) => {
    const cents = price.trim() === '' ? null : Math.round(Number(price) * 100);
    if (cents !== null && (!Number.isFinite(cents) || cents < 0)) { toast('Enter a valid price.', 'error'); return; }
    setBusy(true);
    try {
      const ok = await decideCompiledApproval(a.id, approve, cents, note.trim());
      toast(ok ? (approve ? 'Approved — the workflow continues.' : 'Rejected.') : 'This approval has already been decided or has expired.', ok ? 'success' : 'error');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not record the decision.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const field = 'focus-ring rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
  return (
    <div className="space-y-3 rounded-2xl border border-warning-500/30 bg-bg-secondary p-4">
      <div>
        <p className="text-xs text-text-secondary">{wf?.name ?? 'Workflow'} · {wf?.graph.nodes[a.node_id]?.label ?? a.node_id}</p>
        <p className="mt-1 text-sm font-medium text-text-primary" dir="auto">{a.prompt}</p>
        <p className="mt-1 flex items-center gap-1 text-xs text-text-secondary"><Clock size={12} /> Expires {new Date(a.expires_at).toLocaleTimeString()}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${field} w-36`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Confirmed price ($)" aria-label="Confirmed price in dollars" />
        <input className={`${field} min-w-[12rem] flex-1`} dir="auto" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Note" maxLength={500} />
        <button type="button" disabled={busy} onClick={() => decide(false)} className={btn}>Reject</button>
        <button type="button" disabled={busy} onClick={() => decide(true)} className={btnPrimary}>Approve</button>
      </div>
    </div>
  );
}

// ============================================================
// Page
// ============================================================

export function WorkflowCompilerPage() {
  const [tab, setTab] = useState<TabKey>('compile');
  const [workflows, setWorkflows] = useState<CompiledWorkflow[]>([]);
  const [runs, setRuns] = useState<CompiledRun[]>([]);
  const [approvals, setApprovals] = useState<CompiledApproval[]>([]);
  const [latestId, setLatestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [w, r, a] = await Promise.all([fetchCompiledWorkflows(), fetchCompiledRuns(), fetchPendingCompiledApprovals()]);
      setWorkflows(w); setRuns(r); setApprovals(a);
    } catch (err) {
      if (!quiet) toastRef.current(err instanceof Error ? err.message : 'Could not load workflows.', 'error');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (tab !== 'runs' && tab !== 'approvals') return;
    const t = window.setInterval(() => load(true), 10000);
    return () => window.clearInterval(t);
  }, [tab, load]);

  const byId = useMemo(() => new Map(workflows.map((w) => [w.id, w])), [workflows]);
  const latest = latestId ? byId.get(latestId) ?? null : null;
  const inFlight = runs.filter((r) => r.status === 'active' || r.status === 'waiting_approval' || r.status === 'waiting_timer').length;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold text-text-primary"><WorkflowIcon size={24} /> Workflow Compiler</h1>
            <p className="mt-1 text-sm text-text-secondary">Say what should happen. Vireek compiles it into a safe, approval-gated, fully audited workflow — no building required.</p>
          </div>
          <button type="button" onClick={() => load()} className="focus-ring flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-tertiary">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        <div className="mt-6 flex gap-1 overflow-x-auto rounded-xl bg-bg-tertiary p-1" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
              className={`focus-ring flex-1 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors ${tab === t.key ? 'bg-bg-primary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}>
              {t.label}
              {t.key === 'approvals' && approvals.length > 0 && <span className="ml-1.5 rounded-full bg-warning-500/20 px-1.5 py-0.5 text-xs text-warning-500">{approvals.length}</span>}
              {t.key === 'runs' && inFlight > 0 && <span className="ml-1.5 rounded-full bg-accent-500/20 px-1.5 py-0.5 text-xs text-accent-500">{inFlight}</span>}
            </button>
          ))}
        </div>

        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
          {tab === 'compile' && (
            <CompileTab latest={latest} onCompiled={async (wf) => { setLatestId(wf.id); setWorkflows((prev) => [wf, ...prev.filter((p) => p.id !== wf.id)]); }} onChanged={() => load(true)} onGoRuns={() => setTab('runs')} />
          )}
          {tab === 'workflows' && (loading ? <div className="flex justify-center py-16"><Loader2 size={24} className="animate-spin text-text-secondary" /></div> : <WorkflowsTab workflows={workflows} onChanged={() => load(true)} onGoRuns={() => setTab('runs')} />)}
          {tab === 'runs' && (runs.length === 0 ? <p className="py-12 text-center text-sm text-text-secondary">No runs yet. Start a test run from a compiled workflow.</p> : <div className="space-y-3">{runs.map((r) => <RunRow key={r.id} run={r} wf={byId.get(r.workflow_id)} onChanged={() => load(true)} />)}</div>)}
          {tab === 'approvals' && (approvals.length === 0 ? <p className="py-12 text-center text-sm text-text-secondary">Nothing is waiting for you.</p> : <div className="space-y-3">{approvals.map((a) => <ApprovalCard key={a.id} a={a} wf={byId.get(a.workflow_id)} onChanged={() => load(true)} />)}</div>)}
        </motion.div>
      </div>
    </DashboardLayout>
  );
}
