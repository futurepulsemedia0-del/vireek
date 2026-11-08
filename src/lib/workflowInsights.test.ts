import { describe, expect, it } from 'vitest';
import { lineageOf, outlineOrder, overlayFromAudit } from './workflowInsights';
import type { AuditEvent } from './workflowCompiler';

const ev = (seq: number, event_type: string, node_id: string | null, detail: Record<string, unknown> = {}): AuditEvent =>
  ({ id: seq, run_id: 'r', seq, event_type, node_id, detail, hash: 'h', created_at: '2026-11-01T00:00:00Z' });

describe('overlayFromAudit', () => {
  const events = [
    ev(1, 'node_started', 'a'), ev(2, 'edge_taken', 'a', { edge: 'next' }),
    ev(3, 'node_started', 'b'), ev(4, 'approval_requested', 'b'),
    ev(5, 'edge_taken', 'b', { edge: 'rejected' }), ev(6, 'node_started', 'c'),
  ];
  it('derives per-node state and can be scrubbed to any point in time', () => {
    expect([...overlayFromAudit(events)]).toEqual([['a', 'done'], ['b', 'failed'], ['c', 'active']]);
    expect([...overlayFromAudit(events, 4)]).toEqual([['a', 'done'], ['b', 'waiting']]);
    expect([...overlayFromAudit(events, 0)]).toEqual([]);
  });
  it('supports several active nodes at once (parallel branches) and ignores events without a node', () => {
    const m = overlayFromAudit([ev(1, 'node_started', 't0'), ev(2, 'node_started', 't1'), ev(3, 'sla_breached', null)]);
    expect(m.get('t0')).toBe('active'); expect(m.get('t1')).toBe('active'); expect(m.size).toBe(2);
  });
  it('a failure is never overwritten by a later completion marker', () => {
    const m = overlayFromAudit([ev(1, 'node_started', 'x'), ev(2, 'node_failed', 'x'), ev(3, 'node_completed', 'x')]);
    expect(m.get('x')).toBe('failed');
  });
  it('engine errors and unknown action outcomes read as failed', () => {
    expect(overlayFromAudit([ev(1, 'action_outcome_unknown', 'a')]).get('a')).toBe('failed');
    expect(overlayFromAudit([ev(1, 'engine_error', 'a')]).get('a')).toBe('failed');
  });
  it('input order does not matter', () => {
    expect([...overlayFromAudit([...events].reverse())]).toEqual([...overlayFromAudit(events)]);
  });
});

describe('lineageOf', () => {
  const v = (id: string, parent_id: string | null, n: number) => ({ id, parent_id, created_at: `2026-11-0${n}T00:00:00Z` });
  const all = [v('a', null, 1), v('b', 'a', 2), v('c', 'b', 3), v('d', 'a', 4), v('x', null, 5), v('y', 'x', 6)];
  it('returns the whole family, oldest first, from any member', () => {
    expect(lineageOf(all, 'c').map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(lineageOf(all, 'a').map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(lineageOf(all, 'y').map((x) => x.id)).toEqual(['x', 'y']);
  });
  it('unknown id, orphaned parent and parent cycles are safe', () => {
    expect(lineageOf(all, 'nope')).toEqual([]);
    expect(lineageOf([v('o', 'gone', 1)], 'o').map((x) => x.id)).toEqual(['o']);
    expect(lineageOf([v('p', 'q', 1), v('q', 'p', 2)], 'p').length).toBeGreaterThan(0);
  });
});

describe('outlineOrder', () => {
  const graph = {
    entry: 'c1',
    nodes: { c1: {}, p: {}, t0: {}, t1: {}, j: {}, done: {}, each: {}, undo: {} },
    edges: { c1: { next: 'p' }, p: { b0: 't0', b1: 't1' }, t0: { next: 'j' }, t1: { next: 'j' }, j: { next: 'done' }, done: {}, each: {}, undo: {} },
  } as any;
  it('walks from the entry, visits shared nodes once, and lists unreached nodes as side steps', () => {
    const o = outlineOrder(graph);
    expect(o.main.map((s) => s.id)).toEqual(['c1', 'p', 't0', 't1', 'j', 'done']);
    expect(o.main[1].edges).toEqual([{ on: 'b0', to: 't0' }, { on: 'b1', to: 't1' }]);
    expect(o.side).toEqual(['each', 'undo']);
  });
  it('is safe on cycles and dangling edges', () => {
    const o = outlineOrder({ entry: 'a', nodes: { a: {}, b: {} }, edges: { a: { next: 'b' }, b: { next: 'a', fail: 'ghost' } } } as any);
    expect(o.main.map((s) => s.id)).toEqual(['a', 'b']);
  });
});
