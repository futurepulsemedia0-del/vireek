/**
 * Permit portal adapters (Accela, OpenGov) — STUBS.
 *
 * Manual tracking is the working path today (status, reference number, fees and
 * documents are entered by the team in the Permit Transaction panel). These
 * adapters fix the contract a real integration must meet and make the current
 * "not connected" state explicit instead of silently doing nothing.
 *
 * Rules for stubs: no network calls, no credentials, never report success.
 * A real adapter needs per-authority API access granted by the AHJ and vendor
 * credentials: TODO(owner). Credentials must live server-side (edge function),
 * never in this client module.
 */

import type { PermitStatus, PermitType, PortalSystem } from '@/lib/permitTransactions';

export type PortalCapability = 'submit' | 'fetch_status';

export type PortalErrorCode = 'not_connected' | 'invalid_input' | 'portal_error';

export type PortalResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: PortalErrorCode; message: string };

export interface PortalSubmission {
  applicationId: string;
  permitType: PermitType;
  authorityId: string;
  portalUrl: string | null;
  formName: string | null;
  scopeDescription: string | null;
  applicationData: Record<string, string>;
  documents: { label: string; fileReference: string | null }[];
}

export interface PortalSubmitReceipt {
  referenceNumber: string;
}

export interface PortalStatusSnapshot {
  status: PermitStatus;
  permitNumber: string | null;
}

export interface PermitPortalAdapter {
  readonly system: PortalSystem;
  readonly displayName: string;
  /** False for every stub. A connected adapter must also pass an authority-level check. */
  readonly connected: boolean;
  readonly capabilities: readonly PortalCapability[];
  submit(input: PortalSubmission): Promise<PortalResult<PortalSubmitReceipt>>;
  fetchStatus(referenceNumber: string): Promise<PortalResult<PortalStatusSnapshot>>;
}

const MANUAL_HINT = 'Track this permit manually: file on the authority portal, then record the reference number here.';

function validateSubmission(input: PortalSubmission): string | null {
  if (!input.applicationId.trim()) return 'Missing application id.';
  if (!input.authorityId.trim()) return 'Choose the permitting authority first.';
  if (input.portalUrl && !/^https:\/\//i.test(input.portalUrl)) return 'The portal URL must start with https://.';
  return null;
}

function createStubAdapter(system: PortalSystem, displayName: string): PermitPortalAdapter {
  const notConnected = `${displayName} is not connected yet. ${MANUAL_HINT}`;
  return {
    system,
    displayName,
    connected: false,
    capabilities: [],
    async submit(input) {
      const problem = validateSubmission(input);
      if (problem) return { ok: false, code: 'invalid_input', message: problem };
      return { ok: false, code: 'not_connected', message: notConnected };
    },
    async fetchStatus(referenceNumber) {
      if (!referenceNumber.trim()) {
        return { ok: false, code: 'invalid_input', message: 'Missing reference number.' };
      }
      return { ok: false, code: 'not_connected', message: notConnected };
    },
  };
}

export const accelaAdapter: PermitPortalAdapter = createStubAdapter('accela', 'Accela');
export const openGovAdapter: PermitPortalAdapter = createStubAdapter('opengov', 'OpenGov');

const ADAPTERS: Partial<Record<PortalSystem, PermitPortalAdapter>> = {
  accela: accelaAdapter,
  opengov: openGovAdapter,
};

/** Adapter for a portal system, or null when that system is tracked manually only. */
export function getPortalAdapter(system: PortalSystem): PermitPortalAdapter | null {
  return ADAPTERS[system] ?? null;
}

export type SubmissionMode =
  | { mode: 'manual'; reason: string }
  | { mode: 'adapter'; adapter: PermitPortalAdapter };

/** Decides how an application is filed right now. Today this is always manual. */
export function resolveSubmissionMode(system: PortalSystem): SubmissionMode {
  const adapter = getPortalAdapter(system);
  if (!adapter) return { mode: 'manual', reason: 'No integration exists for this submission channel.' };
  if (!adapter.connected || adapter.capabilities.length === 0) {
    return { mode: 'manual', reason: `${adapter.displayName} integration is not connected.` };
  }
  return { mode: 'adapter', adapter };
}
