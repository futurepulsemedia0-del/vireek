// src/lib/offline/conflictRules.ts
// Written-down conflict policy for the offline outbox. The SERVER is the authority: it answers
// each queued operation with applied / duplicate / conflict / rejected. This table decides what the
// device does with a `conflict` answer.
//
//   discard → the office is already ahead of the device; nothing for the technician to decide.
//   park    → keep the operation on the device in state "conflict" so a person can review it
//             (the capture panel lists it as "needs review"; dismissOp discards it).
//
// Additive operations (note, artifact incl. photos / signatures, location) never overwrite server
// data, so any conflict on them is unexpected and is parked, never silently dropped.
// Reasons not listed here are parked: dropping field data by default would be the unsafe choice.

import type { OutboxOpType } from './db';

export type ConflictResolution = 'discard' | 'park';

const DISCARD: ReadonlyArray<readonly [OutboxOpType, string]> = [
  ['status', 'server_ahead'],
  ['safety_flag', 'newer_flag_on_server'],
];

export function resolveConflict(type: OutboxOpType | string, reason: string | undefined): ConflictResolution {
  return DISCARD.some(([t, r]) => t === type && r === reason) ? 'discard' : 'park';
}
