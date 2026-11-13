// Recreated: verify against original intent
// TODO(vireek): the original what-if simulator is not in the repository; this is the shape the panel renders.
import type { Metrics } from './types';
export type WhatIfScenario =
  | { type: 'tech_unavailable'; techId: string; dayKey: string }
  | { type: 'extend_overtime'; maxOvertimeMin: number };
export interface WhatIfResult { before?: Metrics; after?: Metrics; summary: string[] }
