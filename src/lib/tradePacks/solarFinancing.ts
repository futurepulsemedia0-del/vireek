/**
 * Solar pack — financing tie-in (MODULE HOOK ONLY).
 *
 * No lender, loan or payment logic lives here. A financing module registers a hook and receives pipeline events
 * (e.g. to release a milestone draw when a permit is approved). Hooks are isolated: one failing hook never blocks the
 * pipeline or other hooks. Events carry a deterministic `eventId` so receivers can de-duplicate retries.
 */

import type { SolarStageKey, StageStatus } from './solarPipeline';

export type SolarFinancingEvent =
  | { type: 'stage_changed'; eventId: string; projectId: string; stageKey: SolarStageKey; from: StageStatus; to: StageStatus; at: string }
  | { type: 'project_completed'; eventId: string; projectId: string; at: string };

export interface SolarFinancingHook {
  readonly id: string;
  onEvent(event: SolarFinancingEvent): void | Promise<void>;
}

const hooks = new Map<string, SolarFinancingHook>();

/** Registers (or replaces) a hook; returns an unregister function. */
export function registerSolarFinancingHook(hook: SolarFinancingHook): () => void {
  hooks.set(hook.id, hook);
  return () => {
    if (hooks.get(hook.id) === hook) hooks.delete(hook.id);
  };
}

export function clearSolarFinancingHooks(): void {
  hooks.clear();
}

export function stageEventId(stageId: string, to: StageStatus, at: string): string {
  return `solar:stage:${stageId}:${to}:${at}`;
}

export async function emitSolarFinancingEvent(event: SolarFinancingEvent): Promise<{ delivered: number; failed: Array<{ id: string; error: string }> }> {
  let delivered = 0;
  const failed: Array<{ id: string; error: string }> = [];
  for (const hook of [...hooks.values()]) {
    try {
      await hook.onEvent(event);
      delivered++;
    } catch (e) {
      failed.push({ id: hook.id, error: e instanceof Error ? e.message : 'hook_failed' });
    }
  }
  return { delivered, failed };
}
