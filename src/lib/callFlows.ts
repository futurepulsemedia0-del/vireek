/**
 * Call Flows — visual IVR / call-flow builder: model, validation, simulator and persistence.
 *
 * Everything above the "PERSISTENCE" banner is pure (no network, no React) so it is
 * unit-tested (callFlows.test.ts) and can be ported 1:1 into the edge function that
 * executes a flow during a live call. The simulator and the live engine MUST share this
 * logic, otherwise "what the test call says" and "what callers experience" drift apart.
 *
 * A flow is a small directed graph. Execution starts at `entryId` and follows edges:
 *   menu      -> caller presses a key (or times out) -> next step
 *   hours     -> open / closed / holiday             -> next step
 *   route     -> dial a target; no answer            -> next step
 *   message   -> plays a message                     -> next step or hang up
 *   voicemail -> terminal
 * Every edge that must lead somewhere is "required", so a published flow can never leave
 * a caller in a dead end. Only edges that need no caller input ("auto" edges) can form a
 * loop-free guarantee; a cycle made purely of auto edges is a publish-blocking error.
 */

import { supabase } from '@/lib/supabase';
import {
  DEFAULT_RING_SECONDS,
  E164_PATTERN,
  MAX_GREETING_LENGTH,
  MAX_RING_SECONDS,
  MIN_RING_SECONDS,
  browserTimezone,
  fetchRoutingContext,
  fetchRoutingRecord,
  isOpenAt,
  isValidTimezone,
  newId,
  type RoutingContext,
  type RoutingDepartment,
  type RoutingMember,
  type RoutingTarget,
  type TargetKind,
  type WallClock,
} from '@/lib/callRouting';

// Re-exported so the builder UI has a single import for everything it needs.
export { DEFAULT_RING_SECONDS, MAX_GREETING_LENGTH, MAX_RING_SECONDS, MIN_RING_SECONDS, TARGET_KIND_LABELS } from '@/lib/callRouting';
export type { RoutingTarget, TargetKind } from '@/lib/callRouting';

// ============================================================
// TYPES
// ============================================================

export type FlowNodeKind = 'menu' | 'hours' | 'route' | 'message' | 'voicemail';

export const MENU_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;
export type MenuKey = (typeof MENU_KEYS)[number];

export interface MenuOption {
  key: MenuKey;
  label: string;
  next: string | null;
}

interface NodeBase {
  id: string;
  name: string;
}

export interface MenuNode extends NodeBase {
  kind: 'menu';
  /** Text read to the caller (text-to-speech). */
  prompt: string;
  options: MenuOption[];
  /** How many times the menu repeats after a wrong key or silence. */
  maxRetries: number;
  /** Seconds to wait for a key press. */
  timeoutSeconds: number;
  /** Where to go after the retries are used up. */
  noInputNext: string | null;
}

export interface HoursNode extends NodeBase {
  kind: 'hours';
  openNext: string | null;
  closedNext: string | null;
  /** null = holidays follow the "closed" path. */
  holidayNext: string | null;
}

export interface RouteNode extends NodeBase {
  kind: 'route';
  target: RoutingTarget;
  /** Used when a human target does not answer. Not needed for AI / voicemail targets. */
  noAnswerNext: string | null;
}

export interface MessageNode extends NodeBase {
  kind: 'message';
  text: string;
  /** null = hang up after the message. */
  next: string | null;
}

export interface VoicemailNode extends NodeBase {
  kind: 'voicemail';
  greeting: string;
  transcribe: boolean;
}

export type FlowNode = MenuNode | HoursNode | RouteNode | MessageNode | VoicemailNode;

export interface CallFlowConfig {
  schemaVersion: 1;
  timezone: string;
  entryId: string;
  nodes: FlowNode[];
}

/** Routing context plus the departments defined on the Call Routing page. */
export interface FlowContext extends RoutingContext {
  departments: RoutingDepartment[];
}

export interface FlowEdge {
  /** Stable key of the connection inside its node: `key:1`, `noInput`, `open`, `closed`, `holiday`, `noAnswer`, `next`. */
  slot: string;
  label: string;
  to: string | null;
  /** Taken without any caller input (used for loop detection). */
  auto: boolean;
  /** Must lead somewhere before the flow can be published. */
  required: boolean;
  /** Describes what an empty connection does. */
  emptyLabel: string;
}

export interface FlowIssue {
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
}

export interface FlowSimInput {
  at: WallClock;
  /** Menu answers in order. '' = the caller said / pressed nothing. */
  keys: string[];
  ringOutcome: 'answered' | 'no_answer';
}

export type FlowEndKind = TargetKind | 'hangup';

export interface FlowSimStep {
  nodeId: string;
  name: string;
  kind: FlowNodeKind;
  detail: string;
}

export interface FlowSimResult {
  steps: FlowSimStep[];
  status: 'ended' | 'awaiting_input' | 'error';
  /** The menu waiting for a key press (status === 'awaiting_input'). */
  awaitingNodeId: string | null;
  end: { kind: FlowEndKind; label: string } | null;
  visited: string[];
  facts: { open: boolean; hoursConfigured: boolean; holiday: string | null };
  error?: string;
}

// ============================================================
// CONSTANTS
// ============================================================

export const MAX_NODES = 60;
export const MAX_MENU_OPTIONS = 12;
export const MAX_PROMPT_LENGTH = 500;
export const MAX_FLOW_NAME_LENGTH = 80;
export const MAX_FLOWS = 50;
export const MIN_MENU_TIMEOUT = 3;
export const MAX_MENU_TIMEOUT = 15;
export const DEFAULT_MENU_TIMEOUT = 6;
export const MAX_MENU_RETRIES = 3;
export const DEFAULT_MENU_RETRIES = 2;
const MAX_SIM_STEPS = 200;

export const NODE_KIND_META: Record<FlowNodeKind, { label: string; description: string }> = {
  menu: { label: 'Menu', description: 'Read options and let the caller press a key.' },
  hours: { label: 'Business hours', description: 'Branch on open, closed and holiday.' },
  route: { label: 'Route call', description: 'Send the call to the AI, a person, a department or a number.' },
  message: { label: 'Message', description: 'Play an announcement, then continue or hang up.' },
  voicemail: { label: 'Voicemail', description: 'Record a message from the caller.' },
};

export const NODE_KINDS = Object.keys(NODE_KIND_META) as FlowNodeKind[];

// ============================================================
// SMALL HELPERS
// ============================================================

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asString = (v: unknown, fallback = '', max = 200): string => (typeof v === 'string' ? v.slice(0, max) : fallback);
const isNodeKind = (v: unknown): v is FlowNodeKind => typeof v === 'string' && (NODE_KINDS as string[]).includes(v);
const isMenuKey = (v: unknown): v is MenuKey => typeof v === 'string' && (MENU_KEYS as readonly string[]).includes(v);

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

export const targetRings = (t: RoutingTarget): boolean => t.kind === 'member' || t.kind === 'department' || t.kind === 'phone';

function uniqueName(base: string, existing: readonly FlowNode[]): string {
  const taken = new Set(existing.map((n) => n.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`.toLowerCase())) i += 1;
  return `${base} ${i}`;
}

export function nodeById(config: CallFlowConfig, id: string | null | undefined): FlowNode | undefined {
  return id ? config.nodes.find((n) => n.id === id) : undefined;
}

// ============================================================
// EDGES  (single source of truth for canvas, validation, simulation, clean-up)
// ============================================================

export function nodeEdges(node: FlowNode): FlowEdge[] {
  switch (node.kind) {
    case 'menu':
      return [
        ...node.options.map((o) => ({
          slot: `key:${o.key}`,
          label: o.label.trim() ? `Press ${o.key} · ${o.label.trim()}` : `Press ${o.key}`,
          to: o.next,
          auto: false,
          required: true,
          emptyLabel: 'Not connected',
        })),
        { slot: 'noInput', label: 'No valid choice', to: node.noInputNext, auto: true, required: true, emptyLabel: 'Not connected' },
      ];
    case 'hours':
      return [
        { slot: 'open', label: 'Open', to: node.openNext, auto: true, required: true, emptyLabel: 'Not connected' },
        { slot: 'closed', label: 'Closed', to: node.closedNext, auto: true, required: true, emptyLabel: 'Not connected' },
        { slot: 'holiday', label: 'Holiday', to: node.holidayNext, auto: true, required: false, emptyLabel: 'Same as Closed' },
      ];
    case 'route':
      return targetRings(node.target)
        ? [{ slot: 'noAnswer', label: 'No answer', to: node.noAnswerNext, auto: true, required: true, emptyLabel: 'Not connected' }]
        : [];
    case 'message':
      return [{ slot: 'next', label: 'Then', to: node.next, auto: true, required: false, emptyLabel: 'Hang up' }];
    case 'voicemail':
      return [];
  }
}

export function setEdge(node: FlowNode, slot: string, to: string | null): FlowNode {
  switch (node.kind) {
    case 'menu':
      if (slot === 'noInput') return { ...node, noInputNext: to };
      if (slot.startsWith('key:')) {
        const key = slot.slice(4);
        return { ...node, options: node.options.map((o) => (o.key === key ? { ...o, next: to } : o)) };
      }
      return node;
    case 'hours':
      if (slot === 'open') return { ...node, openNext: to };
      if (slot === 'closed') return { ...node, closedNext: to };
      if (slot === 'holiday') return { ...node, holidayNext: to };
      return node;
    case 'route':
      return slot === 'noAnswer' ? { ...node, noAnswerNext: to } : node;
    case 'message':
      return slot === 'next' ? { ...node, next: to } : node;
    case 'voicemail':
      return node;
  }
}

/** Ids reachable from the entry step through any edge. */
export function reachableIds(config: CallFlowConfig): Set<string> {
  const byId = new Map(config.nodes.map((n) => [n.id, n] as const));
  const seen = new Set<string>();
  const queue: string[] = byId.has(config.entryId) ? [config.entryId] : [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    for (const e of nodeEdges(node)) if (e.to && byId.has(e.to) && !seen.has(e.to)) queue.push(e.to);
  }
  return seen;
}

// ============================================================
// FACTORIES
// ============================================================

export function createNode(kind: FlowNodeKind, existing: readonly FlowNode[]): FlowNode {
  const base = { id: newId('node'), name: uniqueName(NODE_KIND_META[kind].label, existing) };
  switch (kind) {
    case 'menu':
      return { ...base, kind, prompt: '', options: [], maxRetries: DEFAULT_MENU_RETRIES, timeoutSeconds: DEFAULT_MENU_TIMEOUT, noInputNext: null };
    case 'hours':
      return { ...base, kind, openNext: null, closedNext: null, holidayNext: null };
    case 'route':
      return { ...base, kind, target: { kind: 'ai', ringSeconds: DEFAULT_RING_SECONDS }, noAnswerNext: null };
    case 'message':
      return { ...base, kind, text: '', next: null };
    case 'voicemail':
      return { ...base, kind, greeting: 'Please leave your name, number and a short message and we will call you back.', transcribe: true };
  }
}

/** Adds the first unused key to a menu (no-op when the menu is full). */
export function addMenuOption(node: MenuNode): MenuNode {
  if (node.options.length >= MAX_MENU_OPTIONS) return node;
  const used = new Set(node.options.map((o) => o.key));
  const key = MENU_KEYS.find((k) => !used.has(k));
  if (!key) return node;
  return { ...node, options: [...node.options, { key, label: '', next: null }] };
}

/** Blank flow: every call goes straight to the AI receptionist. */
export function createBlankFlow(timezone: string): CallFlowConfig {
  const ai: RouteNode = { id: 'node_ai', kind: 'route', name: 'AI receptionist', target: { kind: 'ai', ringSeconds: DEFAULT_RING_SECONDS }, noAnswerNext: null };
  return { schemaVersion: 1, timezone: isValidTimezone(timezone) ? timezone : 'UTC', entryId: ai.id, nodes: [ai] };
}

/** Sensible starting flow: hours check -> main menu (open) or an after-hours notice (closed). Valid out of the box. */
export function createStarterFlow(timezone: string): CallFlowConfig {
  const nodes: FlowNode[] = [
    { id: 'node_hours', kind: 'hours', name: 'Business hours check', openNext: 'node_menu', closedNext: 'node_after_hours', holidayNext: null },
    {
      id: 'node_menu',
      kind: 'menu',
      name: 'Main menu',
      prompt: 'Thank you for calling. For service or a quote, press 1. To leave a message, press 2.',
      options: [
        { key: '1', label: 'Service or a quote', next: 'node_ai' },
        { key: '2', label: 'Leave a message', next: 'node_voicemail' },
      ],
      maxRetries: DEFAULT_MENU_RETRIES,
      timeoutSeconds: DEFAULT_MENU_TIMEOUT,
      noInputNext: 'node_ai',
    },
    { id: 'node_after_hours', kind: 'message', name: 'After-hours notice', text: 'We are currently closed, but our assistant can still help you.', next: 'node_ai' },
    { id: 'node_ai', kind: 'route', name: 'AI receptionist', target: { kind: 'ai', ringSeconds: DEFAULT_RING_SECONDS }, noAnswerNext: null },
    { id: 'node_voicemail', kind: 'voicemail', name: 'Voicemail', greeting: 'Please leave your name, number and a short message and we will call you back.', transcribe: true },
  ];
  return { schemaVersion: 1, timezone: isValidTimezone(timezone) ? timezone : 'UTC', entryId: 'node_hours', nodes };
}

/** Removes a step and clears every connection that pointed at it, so nothing silently targets a ghost. */
export function removeNode(config: CallFlowConfig, id: string): CallFlowConfig {
  const nodes = config.nodes
    .filter((n) => n.id !== id)
    .map((n) => nodeEdges(n).reduce<FlowNode>((acc, e) => (e.to === id ? setEdge(acc, e.slot, null) : acc), n));
  return { ...config, nodes, entryId: config.entryId === id ? (nodes[0]?.id ?? '') : config.entryId };
}

// ============================================================
// NORMALIZATION (never trust jsonb coming from the database)
// ============================================================

function normalizeTarget(raw: unknown, fallbackKind: TargetKind): RoutingTarget {
  const kinds: TargetKind[] = ['ai', 'member', 'department', 'phone', 'voicemail'];
  const r = isRecord(raw) ? raw : {};
  const kind = kinds.includes(r.kind as TargetKind) ? (r.kind as TargetKind) : fallbackKind;
  const target: RoutingTarget = { kind, ringSeconds: clampInt(r.ringSeconds, MIN_RING_SECONDS, MAX_RING_SECONDS, DEFAULT_RING_SECONDS) };
  if (kind === 'member') target.memberId = asString(r.memberId, '', 64);
  if (kind === 'department') target.departmentId = asString(r.departmentId, '', 64);
  if (kind === 'phone') target.phone = asString(r.phone, '', 20);
  return target;
}

export function normalizeFlow(raw: unknown, fallbackTimezone = 'UTC'): CallFlowConfig | null {
  if (!isRecord(raw)) return null;
  const tz = asString(raw.timezone, fallbackTimezone, 64);

  // Pass 1: keep known step kinds with unique ids.
  const used = new Set<string>();
  const picked: { id: string; kind: FlowNodeKind; r: Record<string, unknown> }[] = [];
  for (const item of Array.isArray(raw.nodes) ? raw.nodes : []) {
    if (picked.length >= MAX_NODES) break;
    if (!isRecord(item) || !isNodeKind(item.kind)) continue;
    let id = asString(item.id, '', 64);
    if (!id || used.has(id)) id = newId('node');
    used.add(id);
    picked.push({ id, kind: item.kind, r: item });
  }

  // Pass 2: build steps; a connection to a step that no longer exists becomes "not connected".
  const link = (v: unknown): string | null => (typeof v === 'string' && used.has(v) ? v : null);
  const nodes: FlowNode[] = picked.map(({ id, kind, r }): FlowNode => {
    const name = asString(r.name, NODE_KIND_META[kind].label, 80);
    switch (kind) {
      case 'menu': {
        const keys = new Set<string>();
        const options: MenuOption[] = [];
        for (const o of Array.isArray(r.options) ? r.options : []) {
          if (!isRecord(o) || !isMenuKey(o.key) || keys.has(o.key) || options.length >= MAX_MENU_OPTIONS) continue;
          keys.add(o.key);
          options.push({ key: o.key, label: asString(o.label, '', 60), next: link(o.next) });
        }
        return {
          id,
          kind,
          name,
          prompt: asString(r.prompt, '', MAX_PROMPT_LENGTH),
          options,
          maxRetries: clampInt(r.maxRetries, 0, MAX_MENU_RETRIES, DEFAULT_MENU_RETRIES),
          timeoutSeconds: clampInt(r.timeoutSeconds, MIN_MENU_TIMEOUT, MAX_MENU_TIMEOUT, DEFAULT_MENU_TIMEOUT),
          noInputNext: link(r.noInputNext),
        };
      }
      case 'hours':
        return { id, kind, name, openNext: link(r.openNext), closedNext: link(r.closedNext), holidayNext: link(r.holidayNext) };
      case 'route':
        return { id, kind, name, target: normalizeTarget(r.target, 'ai'), noAnswerNext: link(r.noAnswerNext) };
      case 'message':
        return { id, kind, name, text: asString(r.text, '', MAX_PROMPT_LENGTH), next: link(r.next) };
      case 'voicemail':
        return { id, kind, name, greeting: asString(r.greeting, '', MAX_GREETING_LENGTH), transcribe: r.transcribe !== false };
    }
  });

  return {
    schemaVersion: 1,
    timezone: isValidTimezone(tz) ? tz : isValidTimezone(fallbackTimezone) ? fallbackTimezone : 'UTC',
    entryId: link(raw.entryId) ?? nodes[0]?.id ?? '',
    nodes,
  };
}

export function flowsEqual(a: CallFlowConfig | null, b: CallFlowConfig | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ============================================================
// TARGET RESOLUTION
// ============================================================

interface Resolved {
  label: string;
  reachable: boolean;
  note?: string;
}

export function resolveFlowTarget(target: RoutingTarget, ctx: FlowContext): Resolved {
  switch (target.kind) {
    case 'ai':
      return { label: `${ctx.assistantName} (AI receptionist)`, reachable: true };
    case 'voicemail':
      return { label: 'Voicemail', reachable: true };
    case 'phone': {
      const ok = !!target.phone && E164_PATTERN.test(target.phone);
      return { label: target.phone || 'Phone number', reachable: ok, note: ok ? undefined : 'Invalid number' };
    }
    case 'member': {
      const m = ctx.members.find((x) => x.id === target.memberId);
      if (!m) return { label: 'Removed team member', reachable: false, note: 'Team member no longer exists' };
      if (!m.phone) return { label: m.name, reachable: false, note: 'No phone number on file' };
      return { label: `${m.name} · ${m.phone}`, reachable: true };
    }
    case 'department': {
      const d = ctx.departments.find((x) => x.id === target.departmentId);
      if (!d) return { label: 'Removed department', reachable: false, note: 'Department no longer exists' };
      const people = d.memberIds.map((id) => ctx.members.find((m) => m.id === id)).filter((m): m is RoutingMember => !!m && !!m.phone);
      if (people.length === 0) return { label: d.name, reachable: false, note: 'Nobody in this department has a phone number' };
      return { label: `${d.name} · ${people.length} reachable (${d.ringStrategy})`, reachable: true };
    }
  }
}

export const describeFlowTarget = (target: RoutingTarget, ctx: FlowContext): string => resolveFlowTarget(target, ctx).label;

// ============================================================
// SIMULATOR
// ============================================================

export function simulateFlow(config: CallFlowConfig, ctx: FlowContext, input: FlowSimInput): FlowSimResult {
  const hoursState = isOpenAt(ctx.businessHours, input.at);
  const holiday = ctx.holidays.find((h) => h.date === input.at.date) ?? null;
  const facts = { open: hoursState.open, hoursConfigured: hoursState.configured, holiday: holiday?.label ?? null };
  const steps: FlowSimStep[] = [];
  const visited: string[] = [];
  const done = (r: Partial<FlowSimResult>): FlowSimResult => ({ steps, status: 'ended', awaitingNodeId: null, end: null, visited, facts, ...r });
  const fail = (error: string): FlowSimResult => done({ status: 'error', error });

  let current: string | null = config.entryId;
  let used = 0;
  let guard = 0;

  while (current) {
    if (guard++ > MAX_SIM_STEPS) return fail('This flow loops without ever reaching an end.');
    const node = nodeById(config, current);
    if (!node) return fail('A connection points to a step that no longer exists.');
    if (!visited.includes(node.id)) visited.push(node.id);
    const log = (detail: string) => steps.push({ nodeId: node.id, name: node.name, kind: node.kind, detail });
    const dead = () => fail(`"${node.name}" has a connection that goes nowhere.`);

    switch (node.kind) {
      case 'menu': {
        log('Plays the menu');
        let attempts = 0;
        let next: string | null = null;
        for (;;) {
          if (used >= input.keys.length) return done({ status: 'awaiting_input', awaitingNodeId: node.id });
          const key = input.keys[used++];
          const option = key ? node.options.find((o) => o.key === key) : undefined;
          if (option) {
            log(`Caller pressed ${key}${option.label.trim() ? ` (${option.label.trim()})` : ''}`);
            next = option.next;
            break;
          }
          attempts += 1;
          const what = key ? `Caller pressed ${key}, which is not an option` : `No key pressed within ${node.timeoutSeconds}s`;
          if (attempts > node.maxRetries) {
            log(`${what} — out of retries`);
            next = node.noInputNext;
            break;
          }
          log(`${what} — the menu repeats (retry ${attempts} of ${node.maxRetries})`);
        }
        if (!next) return dead();
        current = next;
        break;
      }
      case 'hours': {
        let slotNext: string | null;
        if (holiday) {
          slotNext = node.holidayNext ?? node.closedNext;
          log(`Holiday (${holiday.label}) — ${node.holidayNext ? 'holiday path' : 'treated as closed'}`);
        } else if (hoursState.open) {
          slotNext = node.openNext;
          log(hoursState.configured ? 'Open right now' : 'Hours not set — treated as open');
        } else {
          slotNext = node.closedNext;
          log('Closed right now');
        }
        if (!slotNext) return dead();
        current = slotNext;
        break;
      }
      case 'route': {
        const res = resolveFlowTarget(node.target, ctx);
        if (!targetRings(node.target)) {
          log(`Connected to ${res.label}`);
          return done({ end: { kind: node.target.kind, label: res.label } });
        }
        if (res.reachable && input.ringOutcome === 'answered') {
          log(`${res.label} answered`);
          return done({ end: { kind: node.target.kind, label: res.label } });
        }
        log(res.reachable ? `${res.label} did not answer within ${node.target.ringSeconds}s` : `${res.label} could not be dialed (${res.note ?? 'unreachable'})`);
        if (!node.noAnswerNext) {
          steps.push({ nodeId: node.id, name: node.name, kind: node.kind, detail: 'No fallback set — the caller reaches voicemail' });
          return done({ end: { kind: 'voicemail', label: 'Voicemail' } });
        }
        current = node.noAnswerNext;
        break;
      }
      case 'message': {
        log(`Plays: "${node.text.trim().slice(0, 80) || '(empty message)'}"`);
        if (!node.next) {
          steps.push({ nodeId: node.id, name: node.name, kind: node.kind, detail: 'Hangs up' });
          return done({ end: { kind: 'hangup', label: 'Call ends' } });
        }
        current = node.next;
        break;
      }
      case 'voicemail':
        log('Records a voicemail');
        return done({ end: { kind: 'voicemail', label: 'Voicemail' } });
    }
  }
  return fail('This flow has no first step.');
}

// ============================================================
// VALIDATION
// ============================================================

function validateRouteTarget(label: string, t: RoutingTarget, ctx: FlowContext, nodeId: string): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const err = (message: string) => issues.push({ severity: 'error', message: `${label}: ${message}`, nodeId });
  const warn = (message: string) => issues.push({ severity: 'warning', message: `${label}: ${message}`, nodeId });
  if (targetRings(t) && (t.ringSeconds < MIN_RING_SECONDS || t.ringSeconds > MAX_RING_SECONDS)) {
    err(`ring time must be ${MIN_RING_SECONDS}–${MAX_RING_SECONDS} seconds.`);
  }
  if (t.kind === 'phone' && !(t.phone && E164_PATTERN.test(t.phone))) err('enter the number in international format, e.g. +15125550123.');
  if (t.kind === 'member') {
    const m = ctx.members.find((x) => x.id === t.memberId);
    if (!m) err('choose a team member.');
    else if (!m.phone) warn(`${m.name} has no phone number, so calls will skip this step.`);
  }
  if (t.kind === 'department') {
    const d = ctx.departments.find((x) => x.id === t.departmentId);
    if (!d) err('choose a department.');
    else if (!d.memberIds.some((id) => ctx.members.find((m) => m.id === id)?.phone)) warn(`${d.name} has nobody with a phone number, so calls will skip this step.`);
  }
  return issues;
}

/** Finds a cycle made only of edges that need no caller input; returns the step names on it, or null. */
function findAutoCycle(config: CallFlowConfig): FlowNode[] | null {
  const byId = new Map(config.nodes.map((n) => [n.id, n] as const));
  const state = new Map<string, 1 | 2>(); // 1 = on the current path, 2 = finished
  const path: string[] = [];
  const visit = (id: string): FlowNode[] | null => {
    state.set(id, 1);
    path.push(id);
    const node = byId.get(id) as FlowNode;
    for (const e of nodeEdges(node)) {
      if (!e.auto || !e.to || !byId.has(e.to)) continue;
      const s = state.get(e.to);
      if (s === 1) return path.slice(path.indexOf(e.to)).map((x) => byId.get(x) as FlowNode);
      if (!s) {
        const found = visit(e.to);
        if (found) return found;
      }
    }
    path.pop();
    state.set(id, 2);
    return null;
  };
  for (const n of config.nodes) {
    if (!state.has(n.id)) {
      const found = visit(n.id);
      if (found) return found;
    }
  }
  return null;
}

export function validateFlow(config: CallFlowConfig, ctx: FlowContext): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const err = (message: string, nodeId?: string) => issues.push({ severity: 'error', message, nodeId });
  const warn = (message: string, nodeId?: string) => issues.push({ severity: 'warning', message, nodeId });

  if (!isValidTimezone(config.timezone)) err('Time zone is not valid.');
  if (config.nodes.length === 0) {
    err('Add a first step to this flow.');
    return issues;
  }
  if (config.nodes.length > MAX_NODES) err(`A flow can have at most ${MAX_NODES} steps.`);
  const ids = new Set(config.nodes.map((n) => n.id));
  if (!ids.has(config.entryId)) err('Choose which step answers the call first.');

  const names = new Map<string, number>();
  config.nodes.forEach((n) => names.set(n.name.trim().toLowerCase(), (names.get(n.name.trim().toLowerCase()) ?? 0) + 1));

  config.nodes.forEach((node, i) => {
    const label = node.name.trim() || `Step ${i + 1}`;
    if (!node.name.trim()) err(`Step ${i + 1} needs a name.`, node.id);
    else if ((names.get(node.name.trim().toLowerCase()) ?? 0) > 1) warn(`Several steps are named "${node.name.trim()}" — give them different names.`, node.id);

    switch (node.kind) {
      case 'menu': {
        if (!node.prompt.trim()) err(`${label}: write what the caller should hear.`, node.id);
        if (node.options.length === 0) err(`${label}: add at least one key option.`, node.id);
        const keys = node.options.map((o) => o.key);
        if (new Set(keys).size !== keys.length) err(`${label}: each key can be used only once.`, node.id);
        if (node.maxRetries < 0 || node.maxRetries > MAX_MENU_RETRIES) err(`${label}: retries must be 0–${MAX_MENU_RETRIES}.`, node.id);
        if (node.timeoutSeconds < MIN_MENU_TIMEOUT || node.timeoutSeconds > MAX_MENU_TIMEOUT) err(`${label}: wait time must be ${MIN_MENU_TIMEOUT}–${MAX_MENU_TIMEOUT} seconds.`, node.id);
        break;
      }
      case 'hours':
        if (!ctx.businessHours || Object.keys(ctx.businessHours).length === 0) warn(`${label}: business hours are not set, so you are treated as always open.`, node.id);
        break;
      case 'route':
        issues.push(...validateRouteTarget(label, node.target, ctx, node.id));
        break;
      case 'message':
        if (!node.text.trim()) err(`${label}: write the message the caller should hear.`, node.id);
        break;
      case 'voicemail':
        if (node.greeting.length > MAX_GREETING_LENGTH) err(`${label}: greeting is limited to ${MAX_GREETING_LENGTH} characters.`, node.id);
        else if (!node.greeting.trim()) warn(`${label}: no greeting, callers will only hear a beep.`, node.id);
        break;
    }

    for (const e of nodeEdges(node)) {
      if (e.to && !ids.has(e.to)) err(`${label}: "${e.label}" points to a step that no longer exists.`, node.id);
      else if (!e.to && e.required) err(`${label}: choose where "${e.label}" goes.`, node.id);
    }
  });

  const cycle = findAutoCycle(config);
  if (cycle) err(`These steps loop forever without waiting for the caller: ${cycle.map((n) => n.name || 'Untitled').join(' → ')}.`, cycle[0].id);

  const reachable = reachableIds(config);
  config.nodes.forEach((n) => {
    if (ids.has(config.entryId) && !reachable.has(n.id)) warn(`${n.name.trim() || 'Untitled step'} is not connected to the flow, so it never runs.`, n.id);
  });
  return issues;
}

// ============================================================
// PERSISTENCE  (all queries scoped by accountOwnerId; RLS enforces it again)
// ============================================================

export class FlowConflictError extends Error {
  constructor() {
    super('This flow was changed elsewhere. Reload to get the latest version.');
    this.name = 'FlowConflictError';
  }
}
export class FlowNameTakenError extends Error {
  constructor() {
    super('Another flow already uses that name.');
    this.name = 'FlowNameTakenError';
  }
}
export class FlowLiveError extends Error {
  constructor() {
    super('This flow is live. Make another flow live (or take this one offline) before deleting it.');
    this.name = 'FlowLiveError';
  }
}

export interface FlowRecord {
  id: string;
  name: string;
  draft: CallFlowConfig;
  published: CallFlowConfig | null;
  publishedVersion: number;
  publishedAt: string | null;
  updatedAt: string;
}

const codeOf = (error: unknown): string | undefined => (isRecord(error) && typeof error.code === 'string' ? error.code : undefined);

function toFlowRecord(row: Record<string, unknown>, tz: string): FlowRecord | null {
  const draft = normalizeFlow(row.draft, tz);
  if (!draft || typeof row.id !== 'string') return null;
  return {
    id: row.id,
    name: asString(row.name, 'Untitled flow', MAX_FLOW_NAME_LENGTH),
    draft,
    published: row.published ? normalizeFlow(row.published, tz) : null,
    publishedVersion: typeof row.published_version === 'number' ? row.published_version : 0,
    publishedAt: typeof row.published_at === 'string' ? row.published_at : null,
    updatedAt: String(row.updated_at),
  };
}

export async function fetchFlowRecords(accountOwnerId: string): Promise<FlowRecord[]> {
  const { data, error } = await supabase
    .from('call_flows')
    .select('*')
    .eq('account_owner_id', accountOwnerId)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  const tz = browserTimezone();
  return ((data ?? []) as Record<string, unknown>[]).map((r) => toFlowRecord(r, tz)).filter((r): r is FlowRecord => r !== null);
}

export async function fetchFlowRecord(accountOwnerId: string, flowId: string): Promise<FlowRecord | null> {
  const { data, error } = await supabase.from('call_flows').select('*').eq('account_owner_id', accountOwnerId).eq('id', flowId).maybeSingle();
  if (error) throw error;
  return data ? toFlowRecord(data as Record<string, unknown>, browserTimezone()) : null;
}

export async function fetchLiveFlowId(accountOwnerId: string): Promise<string | null> {
  const { data, error } = await supabase.from('call_flow_settings').select('live_flow_id').eq('account_owner_id', accountOwnerId).maybeSingle();
  if (error) throw error;
  const id = (data as { live_flow_id?: string | null } | null)?.live_flow_id;
  return typeof id === 'string' ? id : null;
}

/** Routing context (hours, holidays, team) plus the departments defined on the Call Routing page. */
export async function fetchFlowContext(accountOwnerId: string): Promise<FlowContext> {
  const [ctx, routing] = await Promise.all([fetchRoutingContext(accountOwnerId), fetchRoutingRecord(accountOwnerId)]);
  return { ...ctx, departments: routing?.draft.departments ?? [] };
}

export async function createFlow(accountOwnerId: string, userId: string, name: string, draft: CallFlowConfig): Promise<FlowRecord> {
  const { data, error } = await supabase
    .from('call_flows')
    .insert({ account_owner_id: accountOwnerId, name: name.trim(), draft, updated_by: userId })
    .select('*')
    .single();
  if (error) {
    if (codeOf(error) === '23505') throw new FlowNameTakenError();
    throw error;
  }
  return toFlowRecord(data as Record<string, unknown>, draft.timezone) as FlowRecord;
}

/** Update with optimistic locking. Throws FlowConflictError if someone else saved first. */
export async function saveFlowDraft(accountOwnerId: string, userId: string, flowId: string, name: string, draft: CallFlowConfig, expectedUpdatedAt: string): Promise<FlowRecord> {
  const { data, error } = await supabase
    .from('call_flows')
    .update({ name: name.trim(), draft, updated_by: userId })
    .eq('account_owner_id', accountOwnerId)
    .eq('id', flowId)
    .eq('updated_at', expectedUpdatedAt)
    .select('*');
  if (error) {
    if (codeOf(error) === '23505') throw new FlowNameTakenError();
    throw error;
  }
  if (!data || data.length === 0) throw new FlowConflictError();
  return toFlowRecord(data[0] as Record<string, unknown>, draft.timezone) as FlowRecord;
}

export async function publishFlow(accountOwnerId: string, userId: string, flowId: string, name: string, config: CallFlowConfig, currentVersion: number, expectedUpdatedAt: string): Promise<FlowRecord> {
  const { data, error } = await supabase
    .from('call_flows')
    .update({
      name: name.trim(),
      draft: config,
      published: config,
      published_version: currentVersion + 1,
      published_at: new Date().toISOString(),
      published_by: userId,
      updated_by: userId,
    })
    .eq('account_owner_id', accountOwnerId)
    .eq('id', flowId)
    .eq('published_version', currentVersion)
    .eq('updated_at', expectedUpdatedAt)
    .select('*');
  if (error) {
    if (codeOf(error) === '23505') throw new FlowNameTakenError();
    throw error;
  }
  if (!data || data.length === 0) throw new FlowConflictError();
  return toFlowRecord(data[0] as Record<string, unknown>, config.timezone) as FlowRecord;
}

export async function deleteFlow(accountOwnerId: string, flowId: string): Promise<void> {
  const { error } = await supabase.from('call_flows').delete().eq('account_owner_id', accountOwnerId).eq('id', flowId);
  if (error) {
    if (codeOf(error) === '23503') throw new FlowLiveError();
    throw error;
  }
}

/** Sets (or clears, with null) the single live flow. Only a published flow can go live — enforced by RLS too. */
export async function setLiveFlow(accountOwnerId: string, userId: string, flowId: string | null): Promise<void> {
  const { error } = await supabase
    .from('call_flow_settings')
    .upsert({ account_owner_id: accountOwnerId, live_flow_id: flowId, updated_by: userId, updated_at: new Date().toISOString() }, { onConflict: 'account_owner_id' });
  if (error) throw error;
}

/** "Copy of X", "Copy of X 2" … that fits the name limit and is not taken. */
export function copyName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  const base = `Copy of ${name.trim()}`.slice(0, MAX_FLOW_NAME_LENGTH - 4);
  if (!used.has(base.toLowerCase())) return base;
  let i = 2;
  while (used.has(`${base} ${i}`.toLowerCase())) i += 1;
  return `${base} ${i}`;
}
