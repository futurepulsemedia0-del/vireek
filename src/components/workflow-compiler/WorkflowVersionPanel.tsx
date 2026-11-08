/**
 * Version history, diff, one-click rollback and constrained edits.
 * The browser never writes a graph: every action asks the workflow-compiler function, which re-validates
 * with the same server validator and stores the result as a NEW draft (parent = the version it came from).
 */
import { useMemo, useState } from 'react';
import { GitCompare, History, Loader2, Pencil, RotateCcw } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { CompileError, KIND_LABEL, STATUS_LABEL, diffWorkflows, editWorkflow, rollbackWorkflow } from '@/lib/workflowCompiler';
import type { CompiledWorkflow, EditOp, IrDiff } from '@/lib/workflowCompiler';
import { lineageOf } from '@/lib/workflowInsights';
import { btn, btnPrimary, card, field } from './styles';

interface Props { wf: CompiledWorkflow; all: CompiledWorkflow[]; onChanged: () => void }

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

function DiffView({ diff, label }: { diff: IrDiff; label: (id: string) => string }) {
  if (diff.identical) return <p className="text-sm text-text-secondary">These two versions are identical.</p>;
  return (
    <div className="space-y-3 text-sm" aria-live="polite">
      {diff.meta.length > 0 && (
        <section><h5 className="font-medium text-text-primary">Details</h5>
          <ul className="list-disc ps-5 text-text-secondary">{diff.meta.map((m) => <li key={m.field} dir="auto">{m.field}: {show(m.from)} → {show(m.to)}</li>)}</ul></section>
      )}
      {(diff.nodes.added.length > 0 || diff.nodes.removed.length > 0) && (
        <section><h5 className="font-medium text-text-primary">Steps</h5>
          <ul className="list-disc ps-5 text-text-secondary">
            {diff.nodes.added.map((id) => <li key={`a-${id}`}>Added: {label(id)}</li>)}
            {diff.nodes.removed.map((id) => <li key={`r-${id}`}>Removed: {label(id)}</li>)}
          </ul></section>
      )}
      {diff.nodes.changed.length > 0 && (
        <section><h5 className="font-medium text-text-primary">Changed steps</h5>
          <ul className="space-y-1 ps-5 text-text-secondary">
            {diff.nodes.changed.map((c) => (
              <li key={c.id} className="list-disc"><span dir="auto">{label(c.id)}</span>
                <ul className="list-[circle] ps-5">{c.fields.map((f) => <li key={f.field} className="break-words" dir="auto">{f.field}: {show(f.from)} → {show(f.to)}</li>)}</ul>
              </li>
            ))}
          </ul></section>
      )}
      {(diff.edges.added.length > 0 || diff.edges.removed.length > 0) && (
        <section><h5 className="font-medium text-text-primary">Connections</h5>
          <ul className="list-disc ps-5 text-text-secondary">
            {diff.edges.added.map((e) => <li key={`ea-${e.from}-${e.on}-${e.to}`} dir="auto">Added: {label(e.from)} → {label(e.to)} ({e.on})</li>)}
            {diff.edges.removed.map((e) => <li key={`er-${e.from}-${e.on}-${e.to}`} dir="auto">Removed: {label(e.from)} → {label(e.to)} ({e.on})</li>)}
          </ul></section>
      )}
    </div>
  );
}

export default function WorkflowVersionPanel({ wf, all, onChanged }: Props) {
  const { toast } = useToast();
  const versions = useMemo(() => lineageOf(all, wf.id), [all, wf.id]);
  const [left, setLeft] = useState(() => versions.filter((v) => v.id !== wf.id).at(-1)?.id ?? wf.id);
  const [diff, setDiff] = useState<IrDiff | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const labelOf = (id: string) => {
    const n = wf.graph.nodes[id] ?? all.find((w) => w.id === left)?.graph.nodes[id];
    return n?.label ?? id;
  };

  const run = async <T,>(key: string, fn: () => Promise<T>, ok: (r: T) => string) => {
    setBusy(key); setProblems([]);
    try { const r = await fn(); toast(ok(r), 'success'); return r; }
    catch (err) {
      setProblems(err instanceof CompileError && err.details.length ? err.details : [err instanceof Error ? err.message : 'Something went wrong.']);
      toast(err instanceof Error ? err.message : 'Something went wrong.', 'error');
      return undefined;
    } finally { setBusy(null); }
  };

  const compare = async () => {
    const d = await run('diff', () => diffWorkflows(left, wf.id), () => 'Comparison ready.');
    if (d) setDiff(d);
  };
  const restore = async (id: string) => {
    const r = await run(`rb-${id}`, () => rollbackWorkflow(id), () => 'Restored as a new draft. Review it, test it, then promote it.');
    setConfirmId(null);
    if (r) onChanged();
  };

  // ---- constrained edit form
  const editable = Object.entries(wf.graph.nodes).filter(([, n]) => !n.auto);
  const [opKind, setOpKind] = useState<EditOp['op']>('set_label');
  const [nodeId, setNodeId] = useState(editable[0]?.[0] ?? '');
  const [text, setText] = useState('');
  const [key, setKey] = useState('');
  const [num, setNum] = useState('');

  const buildOp = (): EditOp | null => {
    if (!nodeId) return null;
    if (opKind === 'set_label') return { op: 'set_label', node: nodeId, label: text };
    if (opKind === 'set_timeout_minutes') return { op: 'set_timeout_minutes', node: nodeId, minutes: Number(num) };
    if (opKind === 'set_param') {
      const value: string | number | boolean = num.trim() !== '' && Number.isFinite(Number(num)) ? Number(num) : text;
      return { op: 'set_param', node: nodeId, key, value };
    }
    return null;
  };
  const saveEdit = async () => {
    const op = buildOp();
    if (!op) return;
    const r = await run('edit', () => editWorkflow(wf.id, [op]), () => 'Saved as a new draft. Review it, test it, then promote it.');
    if (r) { setText(''); setKey(''); setNum(''); onChanged(); }
  };

  return (
    <section className={`${card} space-y-4`} aria-label="Version history and edits">
      <div>
        <h4 className="flex items-center gap-1.5 text-sm font-medium text-text-primary"><History size={14} aria-hidden="true" /> Versions</h4>
        <ol className="mt-2 space-y-1.5">
          {versions.map((v, i) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
              <span className="text-text-primary">v{i + 1}{v.id === wf.id ? ' (this one)' : ''}</span>
              <span>{STATUS_LABEL[v.status]} · {new Date(v.created_at).toLocaleString()}</span>
              {v.id !== wf.id && (confirmId === v.id
                ? <>
                    <button type="button" className={btnPrimary} disabled={busy !== null} onClick={() => restore(v.id)}>{busy === `rb-${v.id}` ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />} Yes, restore as new draft</button>
                    <button type="button" className={btn} onClick={() => setConfirmId(null)}>Cancel</button>
                  </>
                : <button type="button" className={btn} onClick={() => setConfirmId(v.id)}><RotateCcw size={14} aria-hidden="true" /> Roll back to v{i + 1}</button>)}
            </li>
          ))}
        </ol>
        <p className="mt-1 text-xs text-text-secondary">Rolling back never deletes anything: it creates a new draft from the old version, checked by the same validator.</p>
      </div>

      {versions.length > 1 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-text-secondary">Compare this version with
              <select className={`${field} mt-1`} value={left} onChange={(e) => { setLeft(e.target.value); setDiff(null); }}>
                {versions.filter((v) => v.id !== wf.id).map((v) => <option key={v.id} value={v.id}>v{versions.indexOf(v) + 1} · {new Date(v.created_at).toLocaleDateString()}</option>)}
              </select>
            </label>
            <button type="button" className={btn} disabled={busy !== null || left === wf.id} onClick={compare}>{busy === 'diff' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <GitCompare size={14} aria-hidden="true" />} Compare</button>
          </div>
          {diff && <DiffView diff={diff} label={labelOf} />}
        </div>
      )}

      <div className="space-y-2">
        <h4 className="flex items-center gap-1.5 text-sm font-medium text-text-primary"><Pencil size={14} aria-hidden="true" /> Adjust a step</h4>
        <p className="text-xs text-text-secondary">Rename a step, change a setting, or change an approval time limit. The result is a new draft; nothing live changes.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-text-secondary">What to change
            <select className={`${field} mt-1`} value={opKind} onChange={(e) => setOpKind(e.target.value as EditOp['op'])}>
              <option value="set_label">Step name</option>
              <option value="set_param">A setting</option>
              <option value="set_timeout_minutes">Approval time limit</option>
            </select>
          </label>
          <label className="text-xs text-text-secondary">Step
            <select className={`${field} mt-1`} value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
              {editable.map(([id, n]) => <option key={id} value={id}>{KIND_LABEL[n.kind]} · {n.label}</option>)}
            </select>
          </label>
          {opKind === 'set_param' && <label className="text-xs text-text-secondary">Setting name<input className={`${field} mt-1`} value={key} onChange={(e) => setKey(e.target.value)} maxLength={40} dir="ltr" /></label>}
          {opKind !== 'set_timeout_minutes' && <label className="text-xs text-text-secondary">{opKind === 'set_label' ? 'New name' : 'Value'}<input className={`${field} mt-1`} dir="auto" value={text} onChange={(e) => setText(e.target.value)} maxLength={opKind === 'set_label' ? 80 : 400} /></label>}
          {(opKind === 'set_timeout_minutes' || opKind === 'set_param') && <label className="text-xs text-text-secondary">{opKind === 'set_timeout_minutes' ? 'Minutes (1 to 10080)' : 'Or a number'}<input className={`${field} mt-1`} inputMode="numeric" value={num} onChange={(e) => setNum(e.target.value)} dir="ltr" /></label>}
        </div>
        <button type="button" className={btnPrimary} disabled={busy !== null || !nodeId} onClick={saveEdit}>{busy === 'edit' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Pencil size={14} aria-hidden="true" />} Save as new draft</button>
      </div>

      {problems.length > 0 && (
        <ul role="alert" className="list-disc ps-5 text-xs text-danger">{problems.map((p) => <li key={p} dir="auto">{p}</li>)}</ul>
      )}
    </section>
  );
}
