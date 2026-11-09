export type PartnerProduct = 'consumer_financing' | 'working_capital' | 'insurance_referral';

export type InsuranceLine = 'general_liability' | 'workers_comp' | 'commercial_auto' | 'equipment' | 'home_warranty';
export const INSURANCE_LINES: readonly InsuranceLine[] = ['general_liability', 'workers_comp', 'commercial_auto', 'equipment', 'home_warranty'];

export interface PartnerCapabilities {
  displayName: string;
  products: readonly PartnerProduct[];
  minAmountCents?: number;
  maxAmountCents?: number;
}

export interface CreateApplicationParams {
  referenceId: string;
  amountCents: number;
  currency: string;
  description: string;
  returnUrl: string;
}
export interface CreateApplicationResult {
  partnerReference: string;
  applicationUrl: string;
}

export type SignalValue = string | number | boolean;
export interface SubmitWorkingCapitalSignalsParams {
  referenceId: string;
  signals: Record<string, SignalValue>;
}
export interface SubmitWorkingCapitalSignalsResult { partnerReference: string }

export interface CreateInsuranceReferralParams {
  referenceId: string;
  line: InsuranceLine;
  businessName: string;
  contactEmail: string | null;
}
export interface CreateInsuranceReferralResult { partnerReference: string }

export interface PartnerWebhookEvent {
  eventId: string;
  kind: 'financing' | 'insurance';
  partnerReference: string;
  status: string;
}

export interface PartnerAdapter {
  readonly key: string;
  readonly capabilities: PartnerCapabilities;
  isConfigured(): boolean;
  createApplication(p: CreateApplicationParams): Promise<CreateApplicationResult>;
  submitWorkingCapitalSignals(p: SubmitWorkingCapitalSignalsParams): Promise<SubmitWorkingCapitalSignalsResult>;
  createInsuranceReferral(p: CreateInsuranceReferralParams): Promise<CreateInsuranceReferralResult>;
  verifyWebhook(rawBody: string, headers: Headers): Promise<boolean>;
  parseWebhook(rawBody: string): PartnerWebhookEvent | null;
}

export type EnvReader = (key: string) => string | undefined;
