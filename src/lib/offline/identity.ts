// src/lib/offline/identity.ts
// Who is the technician on this device? Read synchronously (no await) so offline code paths
// stay simple. Owners / admins who only browse the technician screens have no identity.

export interface CachedIdentity {
  userId: string;
  teamMemberId: string | null;
}

const KEY = 'vireek_field_identity';
let memory: CachedIdentity | null | undefined;

function parse(raw: string | null): CachedIdentity | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CachedIdentity> | null;
    if (!v || typeof v.userId !== 'string' || v.userId === '') return null;
    return { userId: v.userId, teamMemberId: typeof v.teamMemberId === 'string' ? v.teamMemberId : null };
  } catch {
    return null;
  }
}

export function getCachedIdentity(): CachedIdentity | null {
  if (memory !== undefined) return memory;
  try {
    memory = parse(localStorage.getItem(KEY));
  } catch {
    memory = null;
  }
  return memory;
}

export function setCachedIdentity(identity: CachedIdentity | null): void {
  memory = identity;
  try {
    if (identity) localStorage.setItem(KEY, JSON.stringify(identity));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the in-memory copy still works for this session */
  }
}

export const clearCachedIdentity = (): void => setCachedIdentity(null);
