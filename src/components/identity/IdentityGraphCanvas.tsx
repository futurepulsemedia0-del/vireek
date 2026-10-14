import { useMemo } from 'react';
import {
  ENTITY_TYPE_META, layoutGraph, shortUid,
  type IdentityGraph,
} from '@/lib/universalIdentity';

const W = 720;
const H = 420;

/**
 * Deterministic SVG rendering of an identity neighbourhood. Nodes are real buttons-in-spirit
 * (role="button", keyboard activatable) so the graph is usable without a mouse.
 */
export function IdentityGraphCanvas({
  graph,
  selectedId,
  onSelect,
}: {
  graph: IdentityGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const nodes = useMemo(() => layoutGraph(graph.nodes, W, H), [graph.nodes]);
  const pos = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-label={`Identity graph with ${graph.nodes.length} entities and ${graph.edges.length} relationships`}
        className="mx-auto block h-auto w-full min-w-[520px]"
      >
        {graph.edges.map((e) => {
          const a = pos.get(e.src);
          const b = pos.get(e.dst);
          if (!a || !b) return null;
          return (
            <g key={e.id}>
              <line
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="currentColor" className="text-border"
                strokeWidth={1 + e.confidence} strokeDasharray={e.status === 'ended' ? '4 4' : undefined}
              />
              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 3} textAnchor="middle" className="fill-text-secondary" fontSize="9">
                {e.rel_type.replace(/_/g, ' ')}
              </text>
            </g>
          );
        })}
        {nodes.map((n) => {
          const meta = ENTITY_TYPE_META[n.entity_type];
          const active = n.id === selectedId;
          const dim = n.lifecycle_state !== 'active' && n.lifecycle_state !== 'draft';
          return (
            <g
              key={n.id}
              role="button"
              tabIndex={0}
              aria-label={`${meta.label}: ${n.display_name}, ${shortUid(n.uid)}`}
              aria-pressed={active}
              onClick={() => onSelect(n.id)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  onSelect(n.id);
                }
              }}
              className="cursor-pointer outline-none focus-visible:[&>circle]:stroke-[3]"
              opacity={dim ? 0.55 : 1}
            >
              <circle cx={n.x} cy={n.y} r={n.depth === 0 ? 17 : 13} fill={meta.color} stroke={active ? '#fff' : meta.color} strokeWidth={active ? 3 : 1} />
              <text x={n.x} y={n.y + 3.5} textAnchor="middle" fontSize="8.5" fontWeight="700" fill="#fff">{meta.code}</text>
              <text x={n.x} y={n.y + (n.depth === 0 ? 31 : 27)} textAnchor="middle" fontSize="10" className="fill-text-primary">
                {n.display_name.length > 22 ? `${n.display_name.slice(0, 21)}…` : n.display_name}
              </text>
            </g>
          );
        })}
      </svg>
      {graph.truncated && (
        <p className="border-t border-border px-3 py-2 text-[11px] text-text-secondary">
          Showing the closest entities only. Select one to explore further.
        </p>
      )}
    </div>
  );
}
