// supabase/functions/_shared/workflow-compiler/graph-diff.ts
//
// Phase 2 (pure core): version diff, constrained edits, rollback source.
// Principle kept: nothing here is trusted. applyEdits only produces a CANDIDATE ir;
// the caller must send it through compileIr on the server before it is stored as a new draft.
import type { IrEdge, IrNode, WorkflowIr } from "./spec.ts";

// ---------------------------------------------------------------- diff
export interface FieldChange { field: string; from: unknown; to: unknown }
export interface IrDiff {
  identical: boolean;
  nodes: { added: string[]; removed: string[]; changed: { id: string; fields: FieldChange[] }[] };
  edges: { added: IrEdge[]; removed: IrEdge[] };
  meta: FieldChange[];
}

/** Key-order independent JSON, so formatting never shows up as a change. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
const edgeKey = (e: IrEdge) => `${e.from}|${e.on}|${e.to}`;

export function diffIr(a: WorkflowIr, b: WorkflowIr): IrDiff {
  const an = new Map(a.nodes.map((n) => [n.id, n])), bn = new Map(b.nodes.map((n) => [n.id, n]));
  const added = [...bn.keys()].filter((id) => !an.has(id)).sort();
  const removed = [...an.keys()].filter((id) => !bn.has(id)).sort();
  const changed: { id: string; fields: FieldChange[] }[] = [];
  for (const [id, x] of an) {
    const y = bn.get(id);
    if (!y) continue;
    const fields: FieldChange[] = [];
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of [...keys].sort()) {
      const xv = (x as unknown as Record<string, unknown>)[k], yv = (y as unknown as Record<string, unknown>)[k];
      if (stable(xv) !== stable(yv)) fields.push({ field: k, from: xv, to: yv });
    }
    if (fields.length) changed.push({ id, fields });
  }
  const ae = new Map(a.edges.map((e) => [edgeKey(e), e])), be = new Map(b.edges.map((e) => [edgeKey(e), e]));
  const eAdded = [...be].filter(([k]) => !ae.has(k)).map(([, e]) => e);
  const eRemoved = [...ae].filter(([k]) => !be.has(k)).map(([, e]) => e);
  const meta: FieldChange[] = [];
  for (const f of ["name", "summary", "sla_minutes"] as const) if (stable(a[f]) !== stable(b[f])) meta.push({ field: f, from: a[f], to: b[f] });
  if (a.trigger.event !== b.trigger.event) meta.push({ field: "trigger.event", from: a.trigger.event, to: b.trigger.event });
  const identical = !added.length && !removed.length && !changed.length && !eAdded.length && !eRemoved.length && !meta.length;
  return { identical, nodes: { added, removed, changed }, edges: { added: eAdded, removed: eRemoved }, meta };
}

// ---------------------------------------------------------------- rollback
/** Rollback never mutates history: it yields the old graph as the body of a NEW draft (parent = current version). */
export function rollbackCandidate(old: WorkflowIr): WorkflowIr {
  return JSON.parse(JSON.stringify(old)) as WorkflowIr;
}

// ---------------------------------------------------------------- constrained edits
export type EditOp =
  | { op: "set_label"; node: string; label: string }
  | { op: "set_param"; node: string; key: string; value: string | number | boolean }
  | { op: "set_timeout_minutes"; node: string; minutes: number }
  | { op: "swap_adjacent"; first: string; second: string };

export const MAX_EDIT_OPS = 20;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PARAM_KINDS = new Set(["lookup", "action", "verify", "join"]);

export function applyEdits(base: WorkflowIr, ops: readonly EditOp[]): { ir: WorkflowIr | null; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(ops) || ops.length === 0) return { ir: null, errors: ["no edits given"] };
  if (ops.length > MAX_EDIT_OPS) return { ir: null, errors: [`at most ${MAX_EDIT_OPS} edits per draft`] };
  const ir = JSON.parse(JSON.stringify(base)) as WorkflowIr;
  const find = (id: unknown): IrNode | undefined => (typeof id === "string" ? ir.nodes.find((n) => n.id === id) : undefined);

  ops.forEach((o, i) => {
    const at = `edit ${i + 1}`;
    const n = find((o as { node?: string }).node);
    switch (o?.op) {
      case "set_label":
        if (!n) errors.push(`${at}: unknown node`);
        else if (typeof o.label !== "string" || !o.label.trim() || o.label.length > 80) errors.push(`${at}: label must be 1..80 chars`);
        else n.label = o.label.trim();
        break;
      case "set_param":
        if (!n) { errors.push(`${at}: unknown node`); break; }
        if (!PARAM_KINDS.has(n.kind)) { errors.push(`${at}: "${n.kind}" nodes have no editable params`); break; }
        if (typeof o.key !== "string" || !/^[a-z][a-z0-9_]{0,40}$/.test(o.key) || FORBIDDEN_KEYS.has(o.key)) { errors.push(`${at}: invalid param key`); break; }
        if (!["string", "number", "boolean"].includes(typeof o.value) || (typeof o.value === "string" && o.value.length > 400) || (typeof o.value === "number" && !Number.isFinite(o.value))) { errors.push(`${at}: invalid param value`); break; }
        n.params = { ...(n.params ?? {}), [o.key]: o.value };
        break;
      case "set_timeout_minutes":
        if (!n || n.kind !== "approval") errors.push(`${at}: only approval nodes have a timeout`);
        else if (!Number.isInteger(o.minutes) || o.minutes < 1 || o.minutes > 10080) errors.push(`${at}: minutes must be 1..10080`);
        else n.timeout_minutes = o.minutes;
        break;
      case "swap_adjacent": {
        const x = find(o.first), y = find(o.second);
        if (!x || !y || x.id === y.id) { errors.push(`${at}: unknown or identical nodes`); break; }
        const inOf = (id: string) => ir.edges.filter((e) => e.to === id), outOf = (id: string) => ir.edges.filter((e) => e.from === id);
        const xo = outOf(x.id), yo = outOf(y.id), xi = inOf(x.id), yi = inOf(y.id);
        const simple = xo.length === 1 && xo[0].on === "next" && xo[0].to === y.id && yi.length === 1 && yo.length === 1 && yo[0].on === "next" && xi.length >= 1;
        if (!simple) { errors.push(`${at}: nodes must be consecutive "next" steps with no other edges between them`); break; }
        // p -> x -> y -> s   becomes   p -> y -> x -> s
        for (const e of xi) e.to = y.id;
        yo[0].from = x.id; // x -> s
        xo[0].from = y.id; xo[0].to = x.id; // y -> x
        break;
      }
      default:
        errors.push(`${at}: unsupported edit "${String((o as { op?: unknown })?.op)}"`);
    }
  });
  return errors.length ? { ir: null, errors } : { ir, errors: [] };
}
