/**
 * Time-travel debugger for one run: scrub the audit trail step by step (inputs/outputs are redacted),
 * watch the graph overlay follow, and re-run the same kind of event in TEST mode with edited inputs.
 * Read-only on the original run: the what-if starts a brand new simulated run.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, FlaskConical, Loader2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { startTestRun } from '@/lib/workflowCompiler';
import type { AuditEvent, CompiledRun, CompiledWorkflow } from '@/lib/workflowCompiler';
import { overlayFromAudit } from '@/lib/workflowInsights';
import type { NodeState } from '@/lib/workflowInsights';
import { replayFrames } from '../../../supabase/functions/_shared/workflow-compiler/run-analytics.ts';
import { btn, btnPrimary, card, field } from './styles';
import WorkflowOutline from './WorkflowOutline';

interface Props {
  run: CompiledRun;
  wf: CompiledWorkflow;
  events: AuditEvent[];
  renderGraph: (overlay: Map<string, NodeState>) => ReactNode;
  onStarted?: () => void;
}

export default function RunDebugger({ run, wf, events, renderGraph, onStarted }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const sorted = useMemo(() => [...events].sort((a, b) => a.seq - b.seq), [events]);
  const [pos, setPos] = useState(Math.max(0, sorted.length - 1));
  const frames = useMemo(() => replayFrames(sorted, sorted[pos]?.seq ?? 0), [sorted, pos]);
  const overlay = useMemo(() => overlayFromAudit(sorted, sorted[pos]?.seq ?? 0), [sorted, pos]);
  const current = frames.at(-1);

  const trigger = (run.state?.trigger ?? {}) as Record<string, unknown>;
  const [summary, setSummary] = useState(typeof trigger.summary === 'string' ? trigger.summary : '');
  const [name, setName] = useState(run.customer_name ?? '');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  if (sorted.length === 0) return null;

  const whatIf = async () => {
    setBusy(true);
    try {
      await startTestRun(wf.id, { summary: summary.trim(), is_emergency: wf.trigger_event === 'call.emergency', caller_name: name.trim() }, name.trim(), phone.trim());
      toast('Test run started with your edited input. Actions are simulated; find it under Runs & Audit.', 'success');
      onStarted?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the test run.', 'error');
    } finally { setBusy(false); }
  };

  if (!open) return <button type="button" className={btn} onClick={() => setOpen(true)} aria-expanded={false}>Step through this run</button>;

  const label = current?.node ? wf.graph.nodes[current.node]?.label ?? current.node : null;
  return (
    <section className={`${card} space-y-3`} aria-label="Run debugger">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn} onClick={() => setPos((p) => Math.max(0, p - 1))} disabled={pos === 0} aria-label="Previous event"><ChevronLeft size={14} aria-hidden="true" /></button>
        <input
          type="range" min={0} max={sorted.length - 1} value={pos} onChange={(e) => setPos(Number(e.target.value))}
          className="focus-ring min-w-40 flex-1" aria-label="Scrub through run events"
          aria-valuetext={`Event ${pos + 1} of ${sorted.length}${current ? `: ${current.event}` : ''}`}
        />
        <button type="button" className={btn} onClick={() => setPos((p) => Math.min(sorted.length - 1, p + 1))} disabled={pos >= sorted.length - 1} aria-label="Next event"><ChevronRight size={14} aria-hidden="true" /></button>
        <span className="text-xs text-text-secondary" aria-live="polite">Event {pos + 1} of {sorted.length}</span>
        <button type="button" className={btn} onClick={() => setOpen(false)}>Close</button>
      </div>

      {current && (
        <div aria-live="polite">
          <p className="text-sm text-text-primary" dir="auto">#{current.seq} · {current.event}{label ? ` · ${label}` : ''}</p>
          <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-bg-secondary p-2 text-xs text-text-secondary" dir="ltr" tabIndex={0} aria-label="Event details (sensitive values hidden)">
            {JSON.stringify(current.detail, null, 2)}
          </pre>
          <p className="mt-1 text-xs text-text-secondary">Phone numbers, emails, addresses and anything that looks like a secret are hidden here.</p>
        </div>
      )}

      {renderGraph(overlay)}
      <WorkflowOutline wf={wf} overlay={overlay} />

      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-sm font-medium text-text-primary">What if the input had been different?</p>
        <p className="text-xs text-text-secondary">Starts a new test run (simulated actions). This run is not changed. Enter a phone number to test customer lookups.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer name" aria-label="Customer name" maxLength={80} dir="auto" />
          <input className={field} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Customer phone" aria-label="Customer phone" maxLength={32} dir="ltr" />
        </div>
        <textarea className={field} dir="auto" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} aria-label="What the customer said" maxLength={2000} />
        <button type="button" className={btnPrimary} disabled={busy || !summary.trim() || !name.trim()} onClick={whatIf}>
          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <FlaskConical size={14} aria-hidden="true" />} Start test run with this input
        </button>
      </div>
    </section>
  );
}
