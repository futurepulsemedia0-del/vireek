// Single source for the legal-entity details that Impressum (DE DDG §5 / AT / CH) and other
// local legal pages must show. DO NOT GUESS: fill these from your company registration with counsel.
// Empty values keep the Impressum page in its "incomplete" state instead of publishing wrong data.
export interface LegalEntity {
  companyName: string;
  legalForm: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  representative: string;
  email: string;
  phone: string;
  registerCourt: string;
  registerNumber: string;
  vatId: string;
  /** Person responsible for editorial content (§18 MStV) if applicable. */
  contentResponsible: string;
}

export const LEGAL_ENTITY: LegalEntity = {
  companyName: '', legalForm: '', street: '', postalCode: '', city: '', country: '',
  representative: '', email: 'ali@vireek.com', phone: '', registerCourt: '', registerNumber: '',
  vatId: '', contentResponsible: '',
};

/** Fields without which an Impressum is not valid. Register/VAT fields are required only if the entity has them. */
export const IMPRESSUM_REQUIRED: ReadonlyArray<keyof LegalEntity> = [
  'companyName', 'street', 'postalCode', 'city', 'country', 'representative', 'email',
];

export function missingImpressumFields(e: LegalEntity = LEGAL_ENTITY): Array<keyof LegalEntity> {
  return IMPRESSUM_REQUIRED.filter((k) => e[k].trim() === '');
}
