export type NetEventType = 'slow-start' | 'slow-end' | 'degraded' | 'recovered';
export interface NetEvent {
  type: NetEventType;
  at: number;
}
export interface NetViewState {
  slowCount: number;
  degraded: boolean;
  recoveredAt: number | null;
}

export const INITIAL_NET_STATE: NetViewState = { slowCount: 0, degraded: false, recoveredAt: null };
export const RECOVERED_FLASH_MS = 4_000;

export function netReducer(state: NetViewState, event: NetEvent): NetViewState {
  switch (event.type) {
    case 'slow-start':
      return { ...state, slowCount: state.slowCount + 1 };
    case 'slow-end':
      return { ...state, slowCount: Math.max(0, state.slowCount - 1) };
    case 'degraded':
      return { ...state, degraded: true, recoveredAt: null };
    case 'recovered':
      return { ...state, degraded: false, recoveredAt: event.at };
  }
}

export type StripKind = 'degraded' | 'slow' | 'syncing' | 'recovered' | 'dataSaver';

export interface StripInput {
  net: NetViewState;
  now: number;
  slowConnection: boolean;
  syncing: boolean;
  pending: number;
  dataSaverDismissed: boolean;
}

/** Exactly one message at a time, most urgent first. */
export function pickStrip(i: StripInput): StripKind | null {
  if (i.net.degraded) return 'degraded';
  if (i.net.slowCount > 0) return 'slow';
  if (i.syncing && i.pending > 0) return 'syncing';
  if (i.net.recoveredAt !== null && i.now - i.net.recoveredAt < RECOVERED_FLASH_MS) return 'recovered';
  if (i.slowConnection && !i.dataSaverDismissed) return 'dataSaver';
  return null;
}

export interface ConnectionLike {
  effectiveType?: string;
  saveData?: boolean;
}
export function isSlowConnection(c: ConnectionLike | undefined): boolean {
  if (!c) return false;
  return c.saveData === true || c.effectiveType === 'slow-2g' || c.effectiveType === '2g';
}
