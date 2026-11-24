// @vitest-environment node
// Table-driven tests per region. DRAFT rules: these tests pin behaviour, they do not assert what any law requires.
import { describe, expect, it } from 'vitest';
import { inferCallerRegion, resolveConsentProfile, resolvePartyProfile, type ConsentRule, type Region } from './consentProfile.ts';
import { buildRecordingConsentNotice } from './recordingConsent.ts';
import { decideRegionalConsent } from './consentContext.ts';

const US = (s?: string): Region => ({ country: 'US', subdivision: s });

describe('resolvePartyProfile (one region)', () => {
  const rows: Array<[string, Region | null | undefined, ConsentRule, boolean]> = [
    // US: all-party states, one-party states, DC, unknown state
    ['US-CA all-party', US('CA'), 'two_party', true], ['US-FL', US('FL'), 'two_party', true], ['US-WA', US('WA'), 'two_party', true],
    ['US-NV', US('NV'), 'two_party', true], ['US-TX one-party', US('TX'), 'one_party', true], ['US-NY', US('NY'), 'one_party', true],
    ['US-DC', US('dc'), 'one_party', true], ['US no state => unknown', US(null), 'two_party', false], ['US bogus state', US('ZZ'), 'two_party', false],
    // Germany / EU / UK / Australia
    ['DE', { country: 'de' }, 'two_party', true], ['FR', { country: 'FR' }, 'two_party', true], ['ES', { country: 'ES' }, 'two_party', true],
    ['GB', { country: 'GB' }, 'announce_required', true], ['AU', { country: 'AU' }, 'two_party', true],
    // Canada
    ['CA-ON', { country: 'CA', subdivision: 'ON' }, 'announce_required', true], ['CA-BC', { country: 'CA', subdivision: 'bc' }, 'announce_required', true],
    ['CA-QC', { country: 'CA', subdivision: 'QC' }, 'two_party', true], ['CA no province', { country: 'CA' }, 'two_party', false],
    // unknown
    ['null region', null, 'two_party', false], ['empty', {}, 'two_party', false], ['ZZ', { country: 'ZZ' }, 'two_party', false],
    ['3-letter code', { country: 'USA' }, 'two_party', false], ['JP (not modelled)', { country: 'JP' }, 'two_party', false],
  ];
  for (const [name, region, rule, known] of rows) {
    it(`${name} -> ${rule}${known ? '' : ' (unknown, strictest default)'}`, () => {
      const p = resolvePartyProfile(region);
      expect(p.rule).toBe(rule);
      expect(p.known).toBe(known);
    });
  }
});

describe('resolveConsentProfile (business x caller)', () => {
  const rows: Array<[string, Region, Region, ConsentRule, { announce: boolean; explicit: boolean; strict?: boolean }]> = [
    ['US-TX x US-TX', US('TX'), US('TX'), 'one_party', { announce: false, explicit: false }],
    ['US-TX x US-CA: stricter party wins', US('TX'), US('CA'), 'two_party', { announce: true, explicit: true }],
    ['US-CA x US-TX', US('CA'), US('TX'), 'two_party', { announce: true, explicit: true }],
    ['GB x GB', { country: 'GB' }, { country: 'GB' }, 'announce_required', { announce: true, explicit: false }],
    ['US-TX x GB', US('TX'), { country: 'GB' }, 'announce_required', { announce: true, explicit: false }],
    ['GB x DE', { country: 'GB' }, { country: 'DE' }, 'two_party', { announce: true, explicit: true, strict: true }],
    ['DE x DE', { country: 'DE' }, { country: 'DE' }, 'two_party', { announce: true, explicit: true, strict: true }],
    ['DE business x US-TX caller', { country: 'DE' }, US('TX'), 'two_party', { announce: true, explicit: true, strict: true }],
    ['FR x FR (not strict)', { country: 'FR' }, { country: 'FR' }, 'two_party', { announce: true, explicit: true, strict: false }],
    ['AU x AU', { country: 'AU' }, { country: 'AU' }, 'two_party', { announce: true, explicit: true }],
    ['CA-ON x CA-ON', { country: 'CA', subdivision: 'ON' }, { country: 'CA', subdivision: 'ON' }, 'announce_required', { announce: true, explicit: false }],
    ['CA-ON x CA-QC', { country: 'CA', subdivision: 'ON' }, { country: 'CA', subdivision: 'QC' }, 'two_party', { announce: true, explicit: true }],
    ['US-TX x unknown caller => strictest', US('TX'), {}, 'two_party', { announce: true, explicit: true }],
    ['unknown business x US-TX => strictest', {}, US('TX'), 'two_party', { announce: true, explicit: true }],
  ];
  for (const [name, biz, caller, rule, exp] of rows) {
    it(name, () => {
      const p = resolveConsentProfile({ businessRegion: biz, callerRegion: caller });
      expect(p.rule).toBe(rule);
      expect(p.announceRequired).toBe(exp.announce);
      expect(p.explicitConsentRequired).toBe(exp.explicit);
      expect(p.strictRegime).toBe(exp.strict ?? false);
      expect(p.legalReview).toBe('draft');
    });
  }
  it('missing input entirely resolves to the strictest rule and says it defaulted', () => {
    const p = resolveConsentProfile({});
    expect(p.rule).toBe('two_party');
    expect(p.defaultedToStrictest).toBe(true);
  });
  it('known x known does not report a default', () => {
    expect(resolveConsentProfile({ businessRegion: US('TX'), callerRegion: US('NY') }).defaultedToStrictest).toBe(false);
  });
});

describe('inferCallerRegion', () => {
  const area = (a: string) => (a === '415' ? 'CA' : null);
  const rows: Array<[string, string | null, string | null, string | null | undefined, string]> = [
    ['E.164 all-party area code', '+14155550123', 'US', 'CA', 'us_area_code'],
    ['10 digits', '4155550123', 'US', 'CA', 'us_area_code'],
    ['11 digits', '14155550123', 'US', 'CA', 'us_area_code'],
    ['unmapped NANP', '+12145550123', 'US', null, 'nanp_unmapped'],
    ['Canada, Quebec', '+15145550123', 'CA', 'QC', 'ca_area_code'],
    ['Canada, other', '+14165550123', 'CA', null, 'ca_area_code'],
    ['Germany', '+4915112345678', 'DE', undefined, 'calling_code'],
    ['UK 00 prefix', '00447911123456', 'GB', undefined, 'calling_code'],
    ['Australia', '+61412345678', 'AU', undefined, 'calling_code'],
    ['France', '+33612345678', 'FR', undefined, 'calling_code'],
    ['Ireland (3-digit code)', '+353851234567', 'IE', undefined, 'calling_code'],
    ['unrecognised code', '+81312345678', null, undefined, 'unrecognized'],
    ['null', null, null, undefined, 'missing'],
    ['garbage', 'anonymous', null, undefined, 'missing'],
  ];
  for (const [name, num, country, sub, source] of rows) {
    it(name, () => {
      const r = inferCallerRegion(num, area);
      expect(r.source).toBe(source);
      expect(r.region.country ?? null).toBe(country);
      if (sub !== undefined) expect(r.region.subdivision ?? null).toBe(sub);
    });
  }
});

describe('decideRegionalConsent - US behaviour unchanged', () => {
  const callers = ['+14155550123', '+12145550123', '+13105550123', '+12125550123', '4155550123', '+17025550123', null, '', 'anonymous', '+19995550123', '+18765550123'];
  for (const c of callers) {
    it(`US business, caller ${JSON.stringify(c)}: adds nothing beyond the legacy notice`, () => {
      const legacy = buildRecordingConsentNotice(c);
      const d = decideRegionalConsent({ legacyNotice: legacy, businessCountry: 'US', callerNumber: c });
      expect(d.context).toBe('');
    });
  }
  it('legacy notice is never duplicated or replaced, whatever the business country', () => {
    const legacy = buildRecordingConsentNotice('+14155550123');
    expect(legacy.length).toBeGreaterThan(0);
    for (const country of ['US', 'DE', 'GB', null]) expect(decideRegionalConsent({ legacyNotice: legacy, businessCountry: country, callerNumber: '+14155550123' }).context).toBe('');
  });
});

describe('decideRegionalConsent - other regions', () => {
  it('German business: explicit consent, strict wording, German script', () => {
    const d = decideRegionalConsent({ legacyNotice: '', businessCountry: 'DE', callerNumber: '+4915112345678', language: 'de', purpose: 'Qualitätssicherung' });
    expect(d.reason).toBe('applied');
    expect(d.context).toContain('Qualitätssicherung');
    expect(d.context).toContain('Do not record or transcribe anything before the yes');
    expect(d.context).not.toContain('[Purpose]');
  });
  it('UK business and UK caller: announce only (no wait-for-yes)', () => {
    const d = decideRegionalConsent({ legacyNotice: '', businessCountry: 'GB', callerNumber: '+447911123456' });
    expect(d.profile?.rule).toBe('announce_required');
    expect(d.context).toContain('may be recorded');
    expect(d.context).not.toContain('Wait for a clear yes');
  });
  it('UK business, anonymous caller: unknown caller => explicit consent', () => {
    const d = decideRegionalConsent({ legacyNotice: '', businessCountry: 'GB', callerNumber: null });
    expect(d.profile?.rule).toBe('two_party');
    expect(d.context).toContain('Wait for a clear yes');
  });
  it('US business, German caller: resolver applies (new, caller-keyed behaviour)', () => {
    expect(decideRegionalConsent({ legacyNotice: '', businessCountry: 'US', callerNumber: '+4915112345678' }).reason).toBe('applied');
  });
  it('Australian business and caller: explicit consent', () => {
    expect(decideRegionalConsent({ legacyNotice: '', businessCountry: 'AU', callerNumber: '+61412345678' }).profile?.explicitConsentRequired).toBe(true);
  });
  it('Canadian business (province unknown) is strict; the context never claims what the law says', () => {
    const d = decideRegionalConsent({ legacyNotice: '', businessCountry: 'CA', callerNumber: '+14165550123' });
    expect(d.profile?.defaultedToStrictest).toBe(true);
    expect(d.context).not.toMatch(/\b(law|legal|illegal|statute|required by)\b/i);
  });
  it('Canadian business (ON) with a Canadian caller whose province is unknown: strictest', () => {
    const d = decideRegionalConsent({ legacyNotice: '', businessCountry: 'CA', businessSubdivision: 'ON', callerNumber: '+14165550123' });
    expect(d.profile?.rule).toBe('two_party'); // Ontario caller area code 416 resolves to CA with unknown province => strictest
  });
  it('purpose is trimmed, capped and defaulted', () => {
    const long = 'x'.repeat(500);
    expect(decideRegionalConsent({ legacyNotice: '', businessCountry: 'DE', callerNumber: '+4915112345678', purpose: long }).context.length).toBeLessThan(900);
    expect(decideRegionalConsent({ legacyNotice: '', businessCountry: 'DE', callerNumber: '+4915112345678', purpose: '  ' }).context).toContain('quality and service');
  });
});
