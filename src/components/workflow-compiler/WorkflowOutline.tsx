/**
 * Keyboard- and screen-reader-friendly alternative to the SVG graph: the same compiled graph as an ordered list.
 * Optional `overlay` adds each step's run state as TEXT (never colour alone).
 */
import { useMemo } from 'react';
import { KIND_LABEL } from '@/lib/workflowCompiler';
import type { CompiledWorkflow } from '@/lib/workflowCompiler';
import { NODE_STATE_LABEL, outlineOrder } from '@/lib/workflowInsights';
import type { NodeState } from '@/lib/workflowInsights';
import { card, edgeText } from './styles';

interface Props { wf: CompiledWorkflow; overlay?: Map<string, NodeState> }

export default function WorkflowOutline({ wf, overlay }: Props) {
  const { main, side } = useMemo(() => outlineOrder(wf.graph), [wf.graph]);
  const nodes = wf.graph.nodes;
  const labelOf = (id: string) => nodes[id]?.label ?? id;

  return (
    <nav aria-label={`Step outline for ${wf.name}`} className={card}>
      <h4 className="text-sm font-medium text-text-primary">Step outline</h4>
      <p className="mb-2 text-xs text-text-secondary">The same graph as a list, for keyboard and screen-reader use.</p>
      <ol className="space-y-2">
        {main.map((step, i) => {
          const n = nodes[step.id];
          const state = overlay?.get(step.id);
          return (
            <li key={step.id} id={`outline-${step.id}`} className="text-sm">
              <p className="text-text-primary" dir="auto">
                <span className="text-text-secondary">{i + 1}. {KIND_LABEL[n.kind]} · </span>
                {n.label}
                {state && <span className="text-text-secondary"> — {NODE_STATE_LABEL[state]}</span>}
              </p>
              {step.edges.length > 0 && (
                <ul className="ms-4 list-disc text-xs text-text-secondary">
                  {step.edges.map((e) => (
                    <li key={`${e.on}-${e.to}`}>
                      {edgeText(e.on)}: <a href={`#outline-${e.to}`} className="focus-ring underline" dir="auto">{labelOf(e.to)}</a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      {side.length > 0 && (
        <>
          <h5 className="mt-3 text-xs font-medium text-text-primary">Side steps</h5>
          <p className="text-xs text-text-secondary">Run by another step (for each item, or to undo an action); never part of the main flow.</p>
          <ul className="mt-1 space-y-1">
            {side.map((id) => (
              <li key={id} id={`outline-${id}`} className="text-xs text-text-primary" dir="auto">
                {KIND_LABEL[nodes[id].kind]} · {nodes[id].label}
                {overlay?.get(id) && <span className="text-text-secondary"> — {NODE_STATE_LABEL[overlay.get(id) as NodeState]}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </nav>
  );
}
