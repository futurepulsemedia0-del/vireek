// @vitest-environment node
// Reliability tests for the Estimate-to-Cash ("approval-to-cash") workflow playbooks and their contract with the
// estimate-recovery-agent edge function that enrols them. Static + data-driven: no network, no database.
// "KNOWN GAP" tests pin CURRENT behaviour that is a weakness (so it cannot drift silently); they do not endorse it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// workflowEngine.ts imports the Supabase client module; the tests only need its pure exports.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { WORKFLOW_PLAYBOOKS, findPlaybook } from './workflowPlaybooks';
import { TRIGGER_EVENT_LABELS } from './workflowEngine';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const E2C = 'Estimate-to-Cash Recovery';
const e2c = WORKFLOW_PLAYBOOKS.filter((p) => p.category === E2C);
const STEP_TYPES = ['sms', 'call', 'wait', 'webhook', 'human_approval', 'condition_gate'];

describe('playbook catalog integrity', () => {
  it('has unique slugs and findPlaybook resolves each one (and only those)', () => {
    const slugs = WORKFLOW_PLAYBOOKS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const p of WORKFLOW_PLAYBOOKS) expect(findPlaybook(p.slug)).toBe(p);
    expect(findPlaybook('does-not-exist')).toBeUndefined();
    expect(findPlaybook('')).toBeUndefined();
  });

  it.each(WORKFLOW_PLAYBOOKS.map((p) => [p.slug, p] as const))('%s: well-formed steps', (_slug, p) => {
    expect(p.name.trim()).not.toBe('');
    expect(p.trigger_event).toMatch(/^[a-z_]+\.[a-z_]+$/);
    expect(p.steps.length).toBeGreaterThan(0);
    p.steps.forEach((s, i) => {
      expect(s.step_number, 'step numbers are contiguous from 1').toBe(i + 1);
      expect(STEP_TYPES).toContain(s.type);
      expect(Number.isInteger(s.delay_minutes) && s.delay_minutes >= 0).toBe(true);
      expect(['continue', 'stop']).toContain(s.on_failure);
      if (s.type === 'sms') {
        const body = String(s.config.body ?? '');
        expect(body.trim().length, 'sms needs a body').toBeGreaterThan(0);
        const opens = (body.match(/\{\{/g) ?? []).length;
        const closes = (body.match(/\}\}/g) ?? []).length;
        expect(opens, 'balanced {{ }} template braces').toBe(closes);
        for (const m of body.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) expect(m[1]).toMatch(/^[a-z][a-z0-9_]*$/);
      }
      if (s.type === 'condition_gate') expect(String(s.config.check ?? '')).not.toBe('');
      if (s.type === 'call') expect(String(s.config.call_context ?? '')).not.toBe('');
    });
  });

  it('a "wait" step always actually waits (delay > 0), otherwise the sequence fires back-to-back', () => {
    for (const p of WORKFLOW_PLAYBOOKS) for (const s of p.steps) if (s.type === 'wait') expect(s.delay_minutes, `${p.slug} step ${s.step_number}`).toBeGreaterThan(0);
  });
});

describe('approval gates (approval-to-cash safety)', () => {
  const gates = WORKFLOW_PLAYBOOKS.flatMap((p) => p.steps.filter((s) => s.type === 'human_approval').map((s) => [`${p.slug}#${s.step_number}`, s] as const));

  it('the catalog has approval gates to protect', () => {
    expect(gates.length).toBeGreaterThanOrEqual(8);
  });

  it.each(gates)('%s: a rejected/failed approval STOPS the run and states why approval is needed', (_id, s) => {
    expect(s.on_failure, 'on_failure:"continue" would let a rejected approval fall through to the customer').toBe('stop');
    expect(String(s.config.reason ?? '').trim().length).toBeGreaterThan(10);
  });

  it('billing-affecting recovery playbooks put the approval BEFORE any customer-facing message', () => {
    for (const slug of ['estimate-invoice-recovery', 'estimate-parts-unbilled-recovery']) {
      const steps = findPlaybook(slug)!.steps;
      expect(steps[0].type, slug).toBe('human_approval');
    }
  });

  it('in every Estimate-to-Cash playbook, no outbound call follows an unapproved cash ask: any `call` step comes after a gate or a wait', () => {
    for (const p of e2c) {
      const firstCall = p.steps.findIndex((s) => s.type === 'call');
      if (firstCall === -1) continue;
      const before = p.steps.slice(0, firstCall).map((s) => s.type);
      expect(before.some((t) => t === 'human_approval' || t === 'wait'), `${p.slug}: call at step ${firstCall + 1} fires with no approval/wait before it`).toBe(true);
    }
  });

  it('KNOWN GAP: estimate-booking-recovery texts the customer as step 1 with no condition gate (a customer who booked meanwhile would still get the nudge)', () => {
    const steps = findPlaybook('estimate-booking-recovery')!.steps;
    expect(steps[0].type).toBe('sms');
    expect(steps.some((s) => s.type === 'condition_gate')).toBe(false);
  });
});

describe('contract with estimate-recovery-agent', () => {
  const agent = read('supabase/functions/estimate-recovery-agent/index.ts');
  const emitted = [...agent.matchAll(/eventType:\s*"([a-z_.]+)"/g)].map((m) => m[1]);
  const engineSrc = read('src/lib/workflowEngine.ts');
  const unionBlock = engineSrc.slice(engineSrc.indexOf('export type WorkflowTriggerEvent'), engineSrc.indexOf('export type WorkflowStatus'));
  const unionMembers = new Set([...unionBlock.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]));

  it('the agent emits the six documented events', () => {
    expect(emitted.sort()).toEqual([
      'invoice.payment_failed', 'invoice.payment_overdue', 'job.completed_not_invoiced', 'job.parts_unbilled', 'quote.accepted_not_booked', 'quote.financing_needed',
    ]);
  });

  it('every emitted event has exactly one installable playbook listening to it (otherwise a flagged risk is never worked)', () => {
    for (const ev of emitted) expect(WORKFLOW_PLAYBOOKS.filter((p) => p.trigger_event === ev), ev).toHaveLength(1);
  });

  it('every emitted event is part of the WorkflowTriggerEvent type', () => {
    for (const ev of emitted) expect(unionMembers.has(ev), ev).toBe(true);
  });

  it('every playbook trigger is part of the WorkflowTriggerEvent type (the union parses and lists them all)', () => {
    for (const p of WORKFLOW_PLAYBOOKS) expect(unionMembers.has(p.trigger_event), `${p.slug} -> ${p.trigger_event}`).toBe(true);
  });

  it('KNOWN GAP: TRIGGER_EVENT_LABELS (typed Record<WorkflowTriggerEvent,string>) has no label for these triggers, so the UI shows a blank/undefined event name', () => {
    const missing = [...new Set(WORKFLOW_PLAYBOOKS.map((p) => p.trigger_event))].filter((t) => !TRIGGER_EVENT_LABELS[t]).sort();
    expect(missing).toEqual([
      'invoice.payment_failed', 'invoice.payment_overdue', 'job.completed_not_invoiced', 'job.parts_unbilled',
      'membership.churn_risk', 'membership.churned', 'membership.payment_failed', 'membership.renewal_upcoming', 'membership.sold', 'membership.visit_due',
      'quote.accepted_not_booked', 'quote.financing_needed',
    ]);
  });
});
