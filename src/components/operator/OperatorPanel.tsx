import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Loader2, ShieldCheck, Sparkles, Undo2, XCircle } from 'lucide-react';
import { useUndo } from '@/contexts/UndoContext';
import {
  canUndo,
  describeResult,
  executeOperator,
  fetchRecentRuns,
  isPreview,
  OperatorError,
  planOperator,
  undoOperator,
  type ExecuteResponse,
  type OperatorRunRow,
  type PlanPreview,
} from '@/lib/operatorAgent';

type View =
  | { kind: 'planning' }
  | { kind: 'message'; tone: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'preview'; plan: PlanPreview }
  | { kind: 'running'; plan: PlanPreview }
  | { kind: 'done'; plan: PlanPreview; result: ExecuteResponse };

const errText = (e: unknown) => (e instanceof OperatorError ? e.message : 'Something went wrong. Please try again.');

interface Props {
  instruction: string;
  onBack: () => void;
  onClose: () => void;
}

/**
 * Operator inside Cmd+K: plan -> dry-run preview -> approve (unless autonomy
 * settings allow autopilot) -> result with Undo. The server is the authority on
 * approval; this component only reflects its decisions.
 */
export function OperatorPanel({ instruction, onBack, onClose }: Props) {
  const { offerUndo } = useUndo();
  const [view, setView] = useState<View>({ kind: 'planning' });
  const [history, setHistory] = useState<OperatorRunRow[]>([]);
  const alive = useRef(true);
  const started = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const safe = useCallback((v: View) => {
    if (alive.current) setView(v);
  }, []);

  const run = useCallback(
    async (plan: PlanPreview) => {
      safe({ kind: 'running', plan });
      try {
        const result = await executeOperator(plan.run_id, true);
        safe({ kind: 'done', plan, result });
        if (result.undo_available && result.run_id) {
          const runId = result.run_id;
          offerUndo({
            message: describeResult(result),
            tone: result.status === 'completed' ? 'success' : 'info',
            windowMs: 15_000,
            undo: async () => {
              try {
                const r = await undoOperator(runId);
                const { undone, failed, irreversible } = r.summary;
                const parts = [`${undone} restored`, failed ? `${failed} left as they are (changed since)` : '', irreversible ? `${irreversible} sent text${irreversible > 1 ? 's' : ''} can’t be recalled` : ''];
                return { ok: r.status === 'undone', message: parts.filter(Boolean).join(' · ') };
              } catch (e) {
                return { ok: false, message: errText(e) };
              }
            },
          });
        }
      } catch (e) {
        safe({ kind: 'message', tone: 'error', text: errText(e) });
      }
    },
    [offerUndo, safe],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const res = await planOperator(instruction);
        if (!isPreview(res)) {
          safe({ kind: 'message', tone: res.status === 'clarify' ? 'info' : res.status === 'failed' ? 'error' : 'warn', text: res.message });
          return;
        }
        if (!res.approval.required) {
          await run(res); // autonomy settings allow autopilot: execute straight away
          return;
        }
        safe({ kind: 'preview', plan: res });
      } catch (e) {
        safe({ kind: 'message', tone: 'error', text: errText(e) });
      }
    })();
    fetchRecentRuns(4).then((r) => alive.current && setHistory(r)).catch(() => undefined);
  }, [instruction, run, safe]);

  const cancel = async (plan: PlanPreview) => {
    try {
      await executeOperator(plan.run_id, false);
    } catch {
      /* the preview expires on its own */
    }
    onBack();
  };

  const undoFromHistory = async (id: string) => {
    try {
      const r = await undoOperator(id);
      setHistory((h) => h.map((x) => (x.id === id ? { ...x, status: r.status } : x)));
    } catch (e) {
      safe({ kind: 'message', tone: 'error', text: errText(e) });
    }
  };

  return (
    <div className="flex max-h-[60vh] flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <button type="button" onClick={onBack} className="focus-ring rounded p-1 text-text-secondary hover:bg-bg-tertiary" aria-label="Back">
          <ArrowLeft size={16} />
        </button>
        <Sparkles size={15} className="text-accent" />
        <p className="flex-1 truncate text-sm text-text-primary">{instruction}</p>
      </div>

      <div className="overflow-y-auto px-4 py-3">
        {view.kind === 'planning' && (
          <p className="flex items-center gap-2 py-6 text-sm text-text-secondary">
            <Loader2 size={15} className="animate-spin" /> Planning and checking your schedule…
          </p>
        )}

        {view.kind === 'message' && (
          <div className="py-4">
            <p className={`flex items-start gap-2 text-sm ${view.tone === 'error' ? 'text-error-500' : view.tone === 'warn' ? 'text-warning-500' : 'text-text-primary'}`}>
              {view.tone === 'info' ? <Sparkles size={15} className="mt-0.5 shrink-0" /> : <AlertTriangle size={15} className="mt-0.5 shrink-0" />}
              <span>{view.text}</span>
            </p>
            <button type="button" onClick={onBack} className="focus-ring mt-4 rounded-lg border border-border px-3 py-1.5 text-xs text-text-primary hover:bg-bg-tertiary">
              Edit request
            </button>
          </div>
        )}

        {(view.kind === 'preview' || view.kind === 'running' || view.kind === 'done') && (
          <PlanBody plan={view.plan} />
        )}

        {view.kind === 'done' && (
          <div className="mt-3 rounded-lg border border-border bg-bg-tertiary px-3 py-2.5">
            <p className="flex items-center gap-2 text-sm font-medium text-text-primary">
              {view.result.status === 'completed' ? <CheckCircle2 size={15} className="text-success-500" /> : <AlertTriangle size={15} className="text-warning-500" />}
              {describeResult(view.result)}
            </p>
            {(view.result.problems ?? []).map((p, i) => (
              <p key={i} className="mt-1 text-xs text-text-secondary">
                {p.label}: {p.reason}
              </p>
            ))}
            <p className="mt-2 text-[11px] text-text-secondary">Undo is available from the toast and in Recent runs for 24 hours.</p>
          </div>
        )}

        {(view.kind === 'message' || view.kind === 'done') && history.some((h) => canUndo(h)) && (
          <div className="mt-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary/60">Recent runs</p>
            {history.filter((h) => canUndo(h)).map((h) => (
              <div key={h.id} className="flex items-center gap-2 py-1.5">
                <span className="flex-1 truncate text-xs text-text-primary">{h.instruction}</span>
                <button type="button" onClick={() => undoFromHistory(h.id)} className="focus-ring flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text-primary hover:bg-bg-tertiary">
                  <Undo2 size={11} /> Undo
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {view.kind === 'preview' && (
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <p className="flex flex-1 items-center gap-1.5 text-[11px] text-text-secondary">
            <ShieldCheck size={13} /> Needs your approval — nothing has changed yet.
          </p>
          <button type="button" onClick={() => cancel(view.plan)} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs text-text-primary hover:bg-bg-tertiary">
            Cancel
          </button>
          <button type="button" onClick={() => run(view.plan)} className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
            Approve & run
          </button>
        </div>
      )}
      {view.kind === 'running' && (
        <p className="flex items-center gap-2 border-t border-border px-4 py-3 text-xs text-text-secondary">
          <Loader2 size={13} className="animate-spin" /> Running…
        </p>
      )}
      {view.kind === 'done' && (
        <div className="flex justify-end border-t border-border px-4 py-3">
          <button type="button" onClick={onClose} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs text-text-primary hover:bg-bg-tertiary">
            Done
          </button>
        </div>
      )}
    </div>
  );
}

function PlanBody({ plan }: { plan: PlanPreview }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-text-secondary">
        {plan.summary} <span className="text-text-secondary/60">· times in {plan.timezone}</span>
      </p>
      {plan.approval.reasons.length > 0 && (
        <p className="flex items-start gap-2 text-xs text-warning-500">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {plan.approval.reasons.join(' ')}
        </p>
      )}
      {plan.steps.map((s, i) => (
        <section key={s.key}>
          <p className="text-sm font-medium text-text-primary">
            {i + 1}. {s.title} <span className="font-normal text-text-secondary">· {s.affected} affected</span>
          </p>
          {s.note && <p className="text-xs text-text-secondary">{s.note}</p>}
          {s.warnings.map((w, j) => (
            <p key={j} className="mt-1 flex items-start gap-1.5 text-xs text-warning-500">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {w}
            </p>
          ))}
          <ul className="mt-1.5 divide-y divide-border rounded-lg border border-border">
            {s.effects.map((e, j) => (
              <li key={j} className="px-3 py-2">
                <p className="truncate text-xs font-medium text-text-primary">{e.label}</p>
                {e.status === 'skipped' ? (
                  <p className="flex items-center gap-1 text-[11px] text-text-secondary">
                    <XCircle size={11} /> Skipped — {e.reason}
                  </p>
                ) : s.tool === 'message_customers' ? (
                  <p className="text-[11px] text-text-secondary">
                    <span className="text-text-secondary/60">{e.before}</span> “{e.after}”
                  </p>
                ) : (
                  <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-secondary">
                    {e.before} <ArrowRight size={11} /> <span className="text-text-primary">{e.after}</span>
                  </p>
                )}
              </li>
            ))}
          </ul>
          {s.more > 0 && <p className="mt-1 text-[11px] text-text-secondary">+ {s.more} more</p>}
        </section>
      ))}
    </div>
  );
}
