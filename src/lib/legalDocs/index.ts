import type { LegalDoc } from './types';
import { callRecordingDoc } from './callRecording';
import { dataRetentionDoc } from './dataRetention';
import { billingTermsDoc } from './billingTerms';
import { disclaimerDoc } from './disclaimer';
import { limitationOfLiabilityDoc } from './limitationOfLiability';
import { intellectualPropertyDoc } from './intellectualProperty';
import { incidentResponseDoc } from './incidentResponse';
import { exportControlDoc } from './exportControl';

export type { LegalDoc, LegalSection } from './types';

export const LEGAL_DOCS: readonly LegalDoc[] = [
  callRecordingDoc,
  dataRetentionDoc,
  billingTermsDoc,
  disclaimerDoc,
  limitationOfLiabilityDoc,
  intellectualPropertyDoc,
  incidentResponseDoc,
  exportControlDoc,
];

export const LEGAL_DOC_PATHS: readonly string[] = LEGAL_DOCS.map((d) => d.path);

export function getLegalDoc(slug: string): LegalDoc | undefined {
  return LEGAL_DOCS.find((d) => d.slug === slug);
}
