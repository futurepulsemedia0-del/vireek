import { describe, expect, it } from 'vitest';
import { missingImpressumFields, type LegalEntity } from './legalEntity';

const full: LegalEntity = {
  companyName: 'X GmbH', legalForm: 'GmbH', street: 'Str 1', postalCode: '10115', city: 'Berlin', country: 'Germany',
  representative: 'A B', email: 'a@x.de', phone: '', registerCourt: '', registerNumber: '', vatId: '', contentResponsible: '',
};

describe('missingImpressumFields', () => {
  it('reports every required blank field', () => {
    expect(missingImpressumFields({ ...full, street: ' ', city: '' })).toEqual(['street', 'city']);
  });
  it('is empty for a complete entity', () => {
    expect(missingImpressumFields(full)).toEqual([]);
  });
});
