// Recreated: verify against original intent
// src/lib/dispatchOptimizerApi.ts
//
// Client for the Dispatch Optimizer (edge function `dispatch-optimizer`).
// TODO(vireek): the optimizer engine's input builder (`loadOptimizerInput`) and the engine modules the edge function
// imports (evaluate / explain / inputBuilder / suggestions / whatif / emergency) are not in this repository, so the
// feature cannot run. It therefore FAILS CLOSED: `fetchOptimizerAccess` reports `allowed: false`, which makes
// OptimizerPanel render nothing, and every other function refuses instead of inventing a schedule. Restore the
// engine, then replace this file with the real client.

import type { OptInput } from '@/lib/dispatchOptimizer/types';
import type { Suggestion } from '@/lib/dispatchOptimizer/suggestions';
import type { WhatIfResult, WhatIfScenario } from '@/lib/dispatchOptimizer/whatif';
import type { EmergencyResult } from '@/lib/dispatchOptimizer/emergency';
import type { Metrics } from '@/lib/dispatchOptimizer/types';

export interface OptimizerSettings {
  weights: { revenue: number; travel: number; slaRisk: number; overtimeFairness: number };
  maxOvertimeMin: number;
  partsPolicy: 'soft' | 'hard';
  slaHard: boolean;
  seed: number;
}

export interface OptimizerAccess {
  allowed: boolean;
  flag_on: boolean;
  entitled: boolean;
  can_manage: boolean;
  owner_id: string;
  settings: OptimizerSettings;
}

export interface UnplacedJob { jobId: string; reasons: string[] }

export interface OptimizeResponse {
  suggestions: Suggestion[];
  before: Metrics;
  after: Metrics;
  unplaced: UnplacedJob[];
  bundleOnlyCount: number;
  truncatedByTime?: boolean;
}

export class OptimizerUnavailableError extends Error {
  constructor() {
    super('The dispatch optimizer is not available in this deployment.');
    this.name = 'OptimizerUnavailableError';
  }
}

const CLOSED: OptimizerAccess = {
  allowed: false,
  flag_on: false,
  entitled: false,
  can_manage: false,
  owner_id: '',
  settings: { weights: { revenue: 0, travel: 0, slaRisk: 0, overtimeFairness: 0 }, maxOvertimeMin: 0, partsPolicy: 'soft', slaHard: false, seed: 0 },
};

export async function fetchOptimizerAccess(): Promise<OptimizerAccess> {
  return CLOSED;
}

export async function loadOptimizerInput(_args: {
  ownerId: string;
  jobs: unknown[];
  team: unknown[];
  settings: OptimizerSettings;
  scope: 'unassigned_only' | 'all_unlocked';
}): Promise<{ input: OptInput; unavailable: string[] }> {
  throw new OptimizerUnavailableError();
}

export async function runOptimizer(_input: OptInput): Promise<OptimizeResponse> {
  throw new OptimizerUnavailableError();
}

export async function runWhatIf(_input: OptInput, _scenario: WhatIfScenario): Promise<{ whatIf: WhatIfResult }> {
  throw new OptimizerUnavailableError();
}

export async function runEmergency(_input: OptInput, _lateJobId: string, _newEndMs: number): Promise<{ emergency: EmergencyResult }> {
  throw new OptimizerUnavailableError();
}

export async function logSuggestionApplied(_s: Suggestion): Promise<void> {
  // Audit logging only; nothing to record while the optimizer cannot run.
}
