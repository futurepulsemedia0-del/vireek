import type { ReactNode } from 'react';
import { Bot, Building2, CornerDownRight, Flag, Clock, MessageSquareText, PhoneForwarded, PhoneIncoming, Rows3, Voicemail } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  MAX_NODES,
  NODE_KINDS,
  NODE_KIND_META,
  describeFlowTarget,
  nodeById,
  nodeEdges,
  reachableIds,
  type CallFlowConfig,
  type FlowContext,
  type FlowEdge,
  type FlowIssue,
  type FlowNode,
  type FlowNodeKind,
  type FlowSimResult,
} from '@/lib/callFlows';

export const NODE_ICONS: Record<FlowNodeKind, LucideIcon> = {
  menu: Rows3,
  hours: Clock,
  route: PhoneForwarded,
  message: MessageSquareText,
  voicemail: Voicemail,
};

const SELECT_CLASS =
  'focus-ring w-full rounded-xl border bg-bg-primary px-3 py-2 text-sm text-text-primary transition-colors focus-visible:border-accent disabled:opacity-50';

export const NEW_PREFIX = '__new:';

interface EdgeSelectProps {
  node: FlowNode;
  edge: FlowEdge;
  config: CallFlowConfig;
  readOnly: boolean;
  onConnect: (nodeId: string, slot: string, value: string) => void;
}

/** Where one connection goes: nothing, an existing step, or a brand-new step created on the spot. */
function EdgeSelect({ node, edge, config, readOnly, onConnect }: EdgeSelectProps) {
  const full = config.nodes.length >= MAX_NODES;
  return (
    <select
      aria-label={`${node.name || 'Step'}: ${edge.label} goes to`}
      className={`${SELECT_CLASS} ${edge.required && !edge.to ? 'border-danger' : 'border-border'}`}
      value={edge.to ?? ''}
      disabled={readOnly}
      onChange={(e) => onConnect(node.id, edge.slot, e.target.value)}
    >
      <option value="">{edge.emptyLabel}</option>
      {config.nodes.map((n) => (
        <option key={n.id} value={n.id}>
          {n.name || 'Untitled step'}
        </option>
      ))}
      <optgroup label="Create a new step">
        {NODE_KINDS.map((k) => (
          <option key={k} value={`${NEW_PREFIX}${k}`} disabled={full}>
            + {NODE_KIND_META[k].label}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

function summaryOf(node: FlowNode, ctx: FlowContext): string {
  switch (node.kind) {
    case 'menu':
      return node.prompt.trim() ? `“${node.prompt.trim()}”` : 'No prompt yet';
    case 'hours':
      return 'Branches on your business hours and holidays';
    case 'route':
      return `Send to ${describeFlowTarget(node.target, ctx)}`;
    case 'message':
      return node.text.trim() ? `“${node.text.trim()}”` : 'No message yet';
    case 'voicemail':
      return node.greeting.trim() ? `“${node.greeting.trim()}”` : 'No greeting — callers hear a beep';
  }
}

interface FlowCanvasProps {
  config: CallFlowConfig;
  ctx: FlowContext;
  selectedId: string | null;
  issues: FlowIssue[];
  simulation: FlowSimResult | null;
  readOnly?: boolean;
  onSelect: (id: string) => void;
  onConnect: (nodeId: string, slot: string, value: string) => void;
}

/**
 * The visual flow. One mobile-first column: the entry step on top, each connection
 * listed under its step with a selector, and the step it leads to nested below it.
 * A step that is reachable from several places is drawn once and linked everywhere else,
 * so loops ("press 9 to repeat") and shared endings never explode the drawing.
 */
export function FlowCanvas({ config, ctx, selectedId, issues, simulation, readOnly = false, onSelect, onConnect }: FlowCanvasProps) {
  const drawn = new Set<string>();
  const visited = new Set(simulation?.visited ?? []);
  const reachable = reachableIds(config);
  const orphans = config.nodes.filter((n) => !reachable.has(n.id));

  const renderNode = (node: FlowNode, isEntry: boolean): ReactNode => {
    drawn.add(node.id);
    const Icon = NODE_ICONS[node.kind];
    const nodeIssues = issues.filter((i) => i.nodeId === node.id);
    const hasError = nodeIssues.some((i) => i.severity === 'error');
    const selected = selectedId === node.id;
    const onPath = visited.has(node.id);
    const waiting = simulation?.awaitingNodeId === node.id;
    const ring = waiting
      ? 'border-accent ring-2 ring-accent/40'
      : onPath
        ? 'border-success-500 ring-2 ring-success-500/30'
        : selected
          ? 'border-accent ring-2 ring-accent/30'
          : hasError
            ? 'border-danger'
            : 'border-border';
    const edges = nodeEdges(node);

    return (
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => onSelect(node.id)}
          aria-current={selected ? 'true' : undefined}
          aria-label={`Edit step ${node.name || 'Untitled step'}`}
          className={`focus-ring flex w-full items-start gap-3 rounded-2xl border bg-bg-secondary p-4 text-left transition-colors ${ring}`}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Icon size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold text-text-primary">{node.name || 'Untitled step'}</span>
              <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-semibold text-text-secondary">{NODE_KIND_META[node.kind].label}</span>
              {isEntry && (
                <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
                  <Flag size={10} /> Starts here
                </span>
              )}
              {waiting && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">Waiting for a key</span>}
              {hasError && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">Needs attention</span>}
            </span>
            <span className="mt-1 line-clamp-2 block text-xs text-text-secondary">{summaryOf(node, ctx)}</span>
          </span>
        </button>

        {edges.length > 0 && (
          <ul className="mt-2 space-y-2 border-l-2 border-border/70 pl-3 sm:pl-4">
            {edges.map((edge) => {
              const target = nodeById(config, edge.to);
              return (
                <li key={edge.slot} className="min-w-0">
                  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                    <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-text-secondary sm:w-44">
                      <CornerDownRight size={12} aria-hidden="true" className="shrink-0" />
                      <span className="truncate">{edge.label}</span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <EdgeSelect node={node} edge={edge} config={config} readOnly={readOnly} onConnect={onConnect} />
                    </div>
                  </div>
                  {target &&
                    (drawn.has(target.id) ? (
                      <button
                        type="button"
                        onClick={() => onSelect(target.id)}
                        className="focus-ring mt-1.5 ml-4 inline-flex max-w-full items-center gap-1.5 rounded-full bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary"
                      >
                        <CornerDownRight size={12} className="shrink-0" />
                        <span className="truncate">Continues at {target.name || 'Untitled step'}</span>
                      </button>
                    ) : (
                      <div className="mt-2 ml-2 sm:ml-4">{renderNode(target, false)}</div>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  };

  const entry = nodeById(config, config.entryId);
  // Draw the entry first so everything reachable is marked as drawn before we list the leftovers.
  const entryBlock = entry ? renderNode(entry, true) : null;
  const orphanBlocks: ReactNode[] = [];
  for (const n of orphans) {
    if (!drawn.has(n.id)) orphanBlocks.push(<li key={n.id}>{renderNode(n, false)}</li>);
  }

  return (
    <div className="space-y-4" aria-label="Call flow">
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-bg-secondary px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <PhoneIncoming size={16} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">Incoming call</p>
          <p className="text-xs text-text-secondary">Each step below decides what the caller hears and where the call goes next.</p>
        </div>
      </div>

      {entryBlock ? (
        <div className="pl-3 sm:pl-4">{entryBlock}</div>
      ) : (
        <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-text-secondary">
          Choose which step answers the call first, or add a step above.
        </p>
      )}

      {orphanBlocks.length > 0 && (
        <section aria-label="Steps not connected to the flow" className="rounded-2xl border border-dashed border-warning-500/50 p-3">
          <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-text-primary">
            <Bot size={14} className="text-warning-500" /> Not connected yet — these steps never run until you link them
          </p>
          <ul className="space-y-3">{orphanBlocks}</ul>
        </section>
      )}

      {config.nodes.length > 0 && (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Building2 size={12} aria-hidden="true" />
          {config.nodes.length} of {MAX_NODES} steps used
        </p>
      )}
    </div>
  );
}
