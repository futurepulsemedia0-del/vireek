import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  MAX_MENU_OPTIONS,
  MAX_NODES,
  addMenuOption,
  copyName,
  createBlankFlow,
  createNode,
  createStarterFlow,
  nodeEdges,
  normalizeFlow,
  reachableIds,
  removeNode,
  setEdge,
  simulateFlow,
  validateFlow,
} from './callFlows';
import type { CallFlowConfig, FlowContext, FlowNode, FlowSimInput, MenuNode, RouteNode } from './callFlows';

const WEEKDAY = { open: '08:00', close: '17:00', closed: false };

// 2026-10-05 is a Monday, 2026-10-04 a Sunday.
const ctx: FlowContext = {
  assistantName: 'Sarah',
  businessHours: { mon: WEEKDAY, tue: WEEKDAY, wed: WEEKDAY, thu: WEEKDAY, fri: WEEKDAY, sat: { closed: true }, sun: { closed: true } },
  holidays: [{ id: 'h1', date: '2026-12-25', label: 'Christmas' }],
  members: [
    { id: 'm1', name: 'Maria', phone: '+15125550101', languages: [] },
    { id: 'm2', name: 'Ali', phone: null, languages: [] },
  ],
  departments: [{ id: 'd1', name: 'Billing', memberIds: ['m1'], ringStrategy: 'simultaneous' }],
};

const call = (over: Partial<FlowSimInput> = {}): FlowSimInput => ({ at: { date: '2026-10-05', time: '10:00' }, keys: [], ringOutcome: 'answered', ...over });
const errors = (c: CallFlowConfig) => validateFlow(c, ctx).filter((i) => i.severity === 'error');
const find = <T extends FlowNode>(c: CallFlowConfig, id: string) => c.nodes.find((n) => n.id === id) as T;
const replace = (c: CallFlowConfig, node: FlowNode): CallFlowConfig => ({ ...c, nodes: c.nodes.map((n) => (n.id === node.id ? node : n)) });

describe('starter flow', () => {
  it('is valid out of the box and fully reachable', () => {
    const flow = createStarterFlow('America/Chicago');
    expect(errors(flow)).toEqual([]);
    expect(reachableIds(flow).size).toBe(flow.nodes.length);
  });

  it('blank flow is valid and sends calls to the AI', () => {
    const flow = createBlankFlow('UTC');
    expect(errors(flow)).toEqual([]);
    const r = simulateFlow(flow, ctx, call());
    expect(r.status).toBe('ended');
    expect(r.end?.kind).toBe('ai');
  });
});

describe('simulateFlow', () => {
  const flow = createStarterFlow('America/Chicago');

  it('waits for a key press at the menu during business hours', () => {
    const r = simulateFlow(flow, ctx, call());
    expect(r.status).toBe('awaiting_input');
    expect(r.awaitingNodeId).toBe('node_menu');
  });

  it('follows the pressed key', () => {
    expect(simulateFlow(flow, ctx, call({ keys: ['1'] })).end?.kind).toBe('ai');
    const vm = simulateFlow(flow, ctx, call({ keys: ['2'] }));
    expect(vm.end?.kind).toBe('voicemail');
    expect(vm.visited).toEqual(['node_hours', 'node_menu', 'node_voicemail']);
  });

  it('repeats the menu on a wrong key, then falls through after the retries', () => {
    const r = simulateFlow(flow, ctx, call({ keys: ['7', '', '9'] }));
    expect(r.status).toBe('ended');
    expect(r.end?.kind).toBe('ai');
    expect(r.steps.filter((s) => s.detail.includes('menu repeats'))).toHaveLength(2);
    expect(r.steps.some((s) => s.detail.includes('out of retries'))).toBe(true);
  });

  it('takes the closed path outside hours, on weekends and on holidays', () => {
    for (const at of [{ date: '2026-10-05', time: '20:00' }, { date: '2026-10-04', time: '10:00' }, { date: '2026-12-25', time: '10:00' }]) {
      const r = simulateFlow(flow, ctx, call({ at }));
      expect(r.status).toBe('ended');
      expect(r.visited).toEqual(['node_hours', 'node_after_hours', 'node_ai']);
    }
  });

  it('uses the holiday path when one is set', () => {
    const hours = { ...find(flow, 'node_hours'), holidayNext: 'node_voicemail' } as FlowNode;
    const r = simulateFlow(replace(flow, hours), ctx, call({ at: { date: '2026-12-25', time: '10:00' } }));
    expect(r.end?.kind).toBe('voicemail');
  });

  it('escalates to the no-answer step when a person does not pick up', () => {
    let f = createStarterFlow('UTC');
    const menu = find<MenuNode>(f, 'node_menu');
    f = replace(f, { ...menu, options: [{ key: '1', label: 'Maria', next: 'node_person' }, ...menu.options.slice(1)] });
    const person: RouteNode = { id: 'node_person', kind: 'route', name: 'Maria', target: { kind: 'member', memberId: 'm1', ringSeconds: 20 }, noAnswerNext: 'node_voicemail' };
    f = { ...f, nodes: [...f.nodes, person] };
    expect(errors(f)).toEqual([]);

    const answered = simulateFlow(f, ctx, call({ keys: ['1'], ringOutcome: 'answered' }));
    expect(answered.end).toEqual({ kind: 'member', label: 'Maria · +15125550101' });
    const missed = simulateFlow(f, ctx, call({ keys: ['1'], ringOutcome: 'no_answer' }));
    expect(missed.end?.kind).toBe('voicemail');
  });

  it('treats an undialable person as no answer, and falls back to voicemail if nothing is set', () => {
    const flow2 = replace(createBlankFlow('UTC'), { id: 'node_ai', kind: 'route', name: 'Ali', target: { kind: 'member', memberId: 'm2', ringSeconds: 20 }, noAnswerNext: null });
    const r = simulateFlow(flow2, ctx, call());
    expect(r.end?.kind).toBe('voicemail');
    expect(r.steps[0].detail).toContain('No phone number on file');
  });

  it('reports a connection that goes nowhere instead of guessing', () => {
    const broken = replace(createStarterFlow('UTC'), { ...find<MenuNode>(createStarterFlow('UTC'), 'node_menu'), noInputNext: null, options: [{ key: '1', label: '', next: null }] });
    const r = simulateFlow(broken, ctx, call({ keys: ['1'] }));
    expect(r.status).toBe('error');
    expect(r.error).toContain('Main menu');
  });

  it('stops a runaway loop', () => {
    const a: FlowNode = { id: 'a', kind: 'hours', name: 'A', openNext: 'b', closedNext: 'b', holidayNext: null };
    const b: FlowNode = { id: 'b', kind: 'hours', name: 'B', openNext: 'a', closedNext: 'a', holidayNext: null };
    const r = simulateFlow({ schemaVersion: 1, timezone: 'UTC', entryId: 'a', nodes: [a, b] }, ctx, call());
    expect(r.status).toBe('error');
  });

  it('a message with no next step hangs up', () => {
    const msg: FlowNode = { id: 'm', kind: 'message', name: 'Bye', text: 'Goodbye', next: null };
    const r = simulateFlow({ schemaVersion: 1, timezone: 'UTC', entryId: 'm', nodes: [msg] }, ctx, call());
    expect(r.end?.kind).toBe('hangup');
  });
});

describe('validateFlow', () => {
  const messages = (c: CallFlowConfig) => errors(c).map((i) => i.message);

  it('requires at least one step and a valid entry', () => {
    expect(messages({ schemaVersion: 1, timezone: 'UTC', entryId: '', nodes: [] })).toContain('Add a first step to this flow.');
    const flow = { ...createStarterFlow('UTC'), entryId: 'missing' };
    expect(messages(flow)).toContain('Choose which step answers the call first.');
  });

  it('flags unconnected required paths, empty prompts and duplicate keys', () => {
    const flow = createStarterFlow('UTC');
    const menu = find<MenuNode>(flow, 'node_menu');
    const bad = replace(flow, { ...menu, prompt: ' ', options: [{ key: '1', label: '', next: null }, { key: '1', label: '', next: 'node_ai' }], noInputNext: null });
    const m = messages(bad);
    expect(m.some((x) => x.includes('write what the caller should hear'))).toBe(true);
    expect(m.some((x) => x.includes('each key can be used only once'))).toBe(true);
    expect(m.some((x) => x.includes('choose where "Press 1" goes'))).toBe(true);
    expect(m.some((x) => x.includes('choose where "No valid choice" goes'))).toBe(true);
  });

  it('validates phone numbers, team members and departments', () => {
    const flow = createBlankFlow('UTC');
    const route = (target: RouteNode['target']) => replace(flow, { id: 'node_ai', kind: 'route', name: 'Dial', target, noAnswerNext: 'node_ai' });
    expect(messages(route({ kind: 'phone', phone: '5125550123', ringSeconds: 20 })).some((x) => x.includes('international format'))).toBe(true);
    expect(messages(route({ kind: 'member', memberId: '', ringSeconds: 20 })).some((x) => x.includes('choose a team member'))).toBe(true);
    expect(messages(route({ kind: 'department', departmentId: 'gone', ringSeconds: 20 })).some((x) => x.includes('choose a department'))).toBe(true);
    expect(messages(route({ kind: 'department', departmentId: 'd1', ringSeconds: 20 })).filter((x) => x.includes('choose a department'))).toHaveLength(0);
  });

  it('requires a no-answer path only for targets that ring', () => {
    const flow = createBlankFlow('UTC');
    const ringing = replace(flow, { id: 'node_ai', kind: 'route', name: 'Maria', target: { kind: 'member', memberId: 'm1', ringSeconds: 20 }, noAnswerNext: null });
    expect(messages(ringing).some((x) => x.includes('"No answer" goes'))).toBe(true);
    expect(nodeEdges(find(flow, 'node_ai'))).toEqual([]);
  });

  it('blocks loops that never wait for the caller but allows "repeat menu" loops', () => {
    const loop = { schemaVersion: 1 as const, timezone: 'UTC', entryId: 'a', nodes: [
      { id: 'a', kind: 'message', name: 'A', text: 'Hi', next: 'b' } as FlowNode,
      { id: 'b', kind: 'message', name: 'B', text: 'Hi', next: 'a' } as FlowNode,
    ] };
    expect(messages(loop).some((x) => x.includes('loop forever'))).toBe(true);

    const flow = createStarterFlow('UTC');
    const menu = find<MenuNode>(flow, 'node_menu');
    const repeat = replace(flow, { ...menu, options: [...menu.options, { key: '9', label: 'Repeat', next: 'node_menu' }] });
    expect(errors(repeat)).toEqual([]);
  });

  it('warns (but does not block) about unreachable steps and missing hours', () => {
    const flow = createStarterFlow('UTC');
    const orphan = createNode('message', flow.nodes);
    const withOrphan = { ...flow, nodes: [...flow.nodes, { ...orphan, text: 'Unused' } as FlowNode] };
    const issues = validateFlow(withOrphan, { ...ctx, businessHours: null });
    expect(issues.some((i) => i.severity === 'warning' && i.message.includes('not connected'))).toBe(true);
    expect(issues.some((i) => i.severity === 'warning' && i.message.includes('business hours are not set'))).toBe(true);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('editing helpers', () => {
  it('setEdge rewires menu keys, hours branches and no-answer paths', () => {
    const flow = createStarterFlow('UTC');
    const menu = setEdge(find(flow, 'node_menu'), 'key:2', 'node_ai') as MenuNode;
    expect(menu.options.find((o) => o.key === '2')?.next).toBe('node_ai');
    const hours = setEdge(find(flow, 'node_hours'), 'holiday', 'node_voicemail');
    expect(nodeEdges(hours).find((e) => e.slot === 'holiday')?.to).toBe('node_voicemail');
  });

  it('removeNode clears every connection to the removed step and re-points the entry', () => {
    const flow = createStarterFlow('UTC');
    const next = removeNode(flow, 'node_ai');
    expect(next.nodes.some((n) => n.id === 'node_ai')).toBe(false);
    const refs = next.nodes.flatMap((n) => nodeEdges(n)).filter((e) => e.to === 'node_ai');
    expect(refs).toEqual([]);
    expect(errors(next).length).toBeGreaterThan(0);

    const noEntry = removeNode(flow, 'node_hours');
    expect(noEntry.entryId).toBe(noEntry.nodes[0].id);
  });

  it('addMenuOption picks free keys and stops at the limit', () => {
    let menu = createNode('menu', []) as MenuNode;
    for (let i = 0; i < MAX_MENU_OPTIONS + 3; i += 1) menu = addMenuOption(menu);
    expect(menu.options).toHaveLength(MAX_MENU_OPTIONS);
    expect(new Set(menu.options.map((o) => o.key)).size).toBe(MAX_MENU_OPTIONS);
    expect(menu.options[0].key).toBe('1');
  });

  it('createNode gives unique names', () => {
    const a = createNode('menu', []);
    const b = createNode('menu', [a]);
    expect(a.name).toBe('Menu');
    expect(b.name).toBe('Menu 2');
  });

  it('copyName avoids collisions', () => {
    expect(copyName('Main', ['Main'])).toBe('Copy of Main');
    expect(copyName('Main', ['Main', 'Copy of Main'])).toBe('Copy of Main 2');
    expect(copyName('x'.repeat(200), []).length).toBeLessThanOrEqual(80);
  });
});

describe('normalizeFlow', () => {
  it('rejects non-objects and survives garbage', () => {
    expect(normalizeFlow(null)).toBeNull();
    expect(normalizeFlow('x')).toBeNull();
    const empty = normalizeFlow({ nodes: 'nope' }, 'UTC');
    expect(empty?.nodes).toEqual([]);
    expect(empty?.entryId).toBe('');
  });

  it('drops unknown kinds, duplicate keys and dangling connections; clamps numbers', () => {
    const flow = normalizeFlow(
      {
        timezone: 'Not/AZone',
        entryId: 'ghost',
        nodes: [
          { id: 'm', kind: 'menu', name: 'Menu', prompt: 'Hi', maxRetries: 99, timeoutSeconds: 0, noInputNext: 'ghost', options: [{ key: '1', next: 'v' }, { key: '1', next: 'v' }, { key: 'x', next: 'v' }, { key: '2', next: 'ghost' }] },
          { id: 'v', kind: 'voicemail', name: 'VM', greeting: 'Hello' },
          { id: 'bad', kind: 'teleport', name: 'Nope' },
        ],
      },
      'America/Chicago',
    ) as CallFlowConfig;
    expect(flow.timezone).toBe('America/Chicago');
    expect(flow.nodes.map((n) => n.id)).toEqual(['m', 'v']);
    expect(flow.entryId).toBe('m');
    const menu = flow.nodes[0] as MenuNode;
    expect(menu.options).toEqual([{ key: '1', label: '', next: 'v' }, { key: '2', label: '', next: null }]);
    expect(menu.maxRetries).toBe(3);
    expect(menu.timeoutSeconds).toBe(3);
    expect(menu.noInputNext).toBeNull();
  });

  it('gives duplicate ids a fresh id and caps the node count', () => {
    const many = Array.from({ length: MAX_NODES + 10 }, (_, i) => ({ id: i < 2 ? 'same' : `n${i}`, kind: 'voicemail', name: `V${i}` }));
    const flow = normalizeFlow({ nodes: many }) as CallFlowConfig;
    expect(flow.nodes).toHaveLength(MAX_NODES);
    expect(new Set(flow.nodes.map((n) => n.id)).size).toBe(MAX_NODES);
  });

  it('round-trips the starter flow unchanged', () => {
    const flow = createStarterFlow('America/Chicago');
    expect(normalizeFlow(JSON.parse(JSON.stringify(flow)))).toEqual(flow);
  });
});
