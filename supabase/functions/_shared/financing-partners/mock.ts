import type { EnvReader, PartnerAdapter, PartnerWebhookEvent } from './types.ts';
import { verifyWebhookSignature } from './signature.ts';
import { isFinancingStatus, isInsuranceStatus } from './stateMachine.ts';

export const MOCK_PARTNER_KEY = 'mock';
export const MOCK_SIGNATURE_HEADER = 'X-Partner-Signature';

const defaultEnv: EnvReader = (k) => (typeof Deno !== 'undefined' ? Deno.env.get(k) : undefined);

export function createMockPartner(env: EnvReader = defaultEnv): PartnerAdapter {
  return {
    key: MOCK_PARTNER_KEY,
    capabilities: {
      displayName: 'Sandbox Lending Partner',
      products: ['consumer_financing', 'working_capital', 'insurance_referral'],
      minAmountCents: 20_000,
      maxAmountCents: 10_000_000,
    },
    isConfigured: () => env('FINANCING_PARTNER_ALLOW_MOCK') === 'true',

    async createApplication(p) {
      const partnerReference = `mock_app_${p.referenceId}`;
      return { partnerReference, applicationUrl: `https://partner-sandbox.invalid/apply/${partnerReference}` };
    },
    async submitWorkingCapitalSignals(p) {
      return { partnerReference: `mock_wc_${p.referenceId}` };
    },
    async createInsuranceReferral(p) {
      return { partnerReference: `mock_ins_${p.referenceId}` };
    },

    verifyWebhook(rawBody, headers) {
      return verifyWebhookSignature(rawBody, headers.get(MOCK_SIGNATURE_HEADER), env('FINANCING_PARTNER_MOCK_WEBHOOK_SECRET'));
    },

    parseWebhook(rawBody): PartnerWebhookEvent | null {
      let j: Record<string, unknown>;
      try { j = JSON.parse(rawBody); } catch { return null; }
      if (!j || typeof j !== 'object') return null;
      const eventId = typeof j.id === 'string' ? j.id : '';
      const reference = typeof j.reference === 'string' ? j.reference : '';
      const status = typeof j.status === 'string' ? j.status : '';
      if (!eventId || eventId.length > 128 || !reference || reference.length > 128) return null;
      if (j.type === 'financing.status' && isFinancingStatus(status)) return { eventId, kind: 'financing', partnerReference: reference, status };
      if (j.type === 'insurance.status' && isInsuranceStatus(status)) return { eventId, kind: 'insurance', partnerReference: reference, status };
      return null;
    },
  };
}

export const mockPartner = createMockPartner();
