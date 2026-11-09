import type { PartnerAdapter } from './types.ts';
import { mockPartner } from './mock.ts';

const PARTNERS: Record<string, PartnerAdapter> = {
  [mockPartner.key]: mockPartner,
};

export function getPartner(key: string): PartnerAdapter | null {
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(key)) return null;
  const p = PARTNERS[key];
  return p && p.isConfigured() ? p : null;
}

export function listConfiguredPartners(): PartnerAdapter[] {
  return Object.values(PARTNERS).filter((p) => p.isConfigured());
}
