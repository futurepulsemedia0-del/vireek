import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formErrorMap, msg, parseMsg } from './errors';
import { phoneMask, normalizePhone } from './phone';
import { consentField, dateField, emailField, licenseField, moneyField, percentField, phoneField, postalField, textField } from './schemas';

const err = (schema: z.ZodTypeAny, v: unknown) => {
  const r = schema.safeParse(v, { errorMap: formErrorMap });
  return r.success ? null : parseMsg(r.error.issues[0]?.message ?? '').key;
};

describe('validation matrix (plain-language keys, never "Invalid input")', () => {
  it.each([
    [textField(), '   ', 'forms.errors.required'],
    [textField({ min: 3 }), 'ab', 'forms.errors.tooShort'],
    [emailField(), '', 'forms.errors.emailRequired'],
    [emailField(), 'a@b', 'forms.errors.email'],
    [phoneField({ defaultCountry: 'US' }), '', 'forms.errors.phoneRequired'],
    [phoneField({ defaultCountry: 'US' }), '555', 'forms.errors.phoneTooShort'],
    [phoneField({ defaultCountry: 'US' }), '1234567890123', 'forms.errors.phoneInvalid'],
    [moneyField(), '', 'forms.errors.amountRequired'],
    [moneyField({ min: 100 }), '0.50', 'forms.errors.amountTooSmall'],
    [percentField(), '101', 'forms.errors.percentRange'],
    [dateField(), '03/1', 'forms.errors.dateIncomplete'],
    [dateField(), '2024-02-30', 'forms.errors.dateInvalid'],
    [postalField('US'), '1234', 'forms.errors.postalInvalid'],
    [licenseField(), 'ab', 'forms.errors.licenseInvalid'],
    [consentField(), false, 'forms.errors.consentRequired'],
  ])('%#', (schema, value, key) => expect(err(schema, value)).toBe(key));

  it('optional fields accept empty', () => {
    expect(err(emailField({ required: false }), '')).toBeNull();
    expect(err(phoneField({ defaultCountry: 'US', required: false }), '')).toBeNull();
  });
  it('normalizes outputs', () => {
    expect(phoneField({ defaultCountry: 'US' }).parse('(202) 555-0123')).toBe('+12025550123');
    expect(moneyField().parse('1234.5')).toBe(123450);
    expect(emailField().parse(' A@B.COM ')).toBe('a@b.com');
    expect(msg('x')).toBe('x');
  });
});

describe('phone across countries', () => {
  it.each([
    ['US', '2025550123', '+12025550123'],
    ['GB', '07911 123456', '+447911123456'],
    ['DE', '0151 23456789', '+4915123456789'],
    ['FR', '06 12 34 56 78', '+33612345678'],
    ['AU', '0412 345 678', '+61412345678'],
    ['US', '+44 7911 123456', '+447911123456'],
    ['IR', '۰۹۱۲ ۳۴۵ ۶۷۸۹', '+989123456789'],
  ] as const)('%s %s', (country, input, e164) => {
    expect(normalizePhone(input, country)?.e164).toBe(e164);
    const m = phoneMask(country).format(input);
    expect(m.display.length).toBeGreaterThan(0);
  });
  it('mask never exceeds 15 digits', () => expect(phoneMask('US').format('+1234567890123456789').value.replace(/\D/g, '').length).toBeLessThanOrEqual(15));
});
