import { describe, expect, it } from 'vitest';
import { ACTION_FILESET_NAME, buildFeedFiles, ENTITY_FILESET_NAME, partitionMerchants, toAction, toE164, toEntity, validateMerchant, type RedirectMerchant } from './feeds';

const merchant = (over: Partial<RedirectMerchant> = {}): RedirectMerchant => ({
  entityId: 'u-123',
  name: ' Acme Plumbing ',
  phone: '(415) 555-0100',
  bookingUrl: 'https://app.vireek.com/book/acme',
  address: { country: 'US', locality: 'San Francisco', region: 'CA', postalCode: '94103', streetAddress: '1 Market St' },
  ...over,
});

describe('toE164', () => {
  it('normalises US numbers and keeps international numbers', () => {
    expect(toE164('(415) 555-0100')).toBe('+14155550100');
    expect(toE164('1-415-555-0100')).toBe('+14155550100');
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
  });
  it('returns null instead of guessing', () => {
    expect(toE164('555-0100')).toBeNull();
    expect(toE164('')).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164('+0123')).toBeNull();
  });
});

describe('validateMerchant', () => {
  it('accepts a complete merchant', () => expect(validateMerchant(merchant())).toBeNull());
  it('rejects each missing required field with a reason', () => {
    expect(validateMerchant(merchant({ entityId: 'has space' }))).toBe('entity_id_invalid');
    expect(validateMerchant(merchant({ name: '  ' }))).toBe('name_missing');
    expect(validateMerchant(merchant({ bookingUrl: 'http://x.com/book' }))).toBe('booking_url_not_https');
    expect(validateMerchant(merchant({ bookingUrl: 'not a url' }))).toBe('booking_url_not_https');
    expect(validateMerchant(merchant({ address: { ...merchant().address, country: 'usa' } }))).toBe('address_country_invalid');
    expect(validateMerchant(merchant({ address: { ...merchant().address, locality: '' } }))).toBe('address_locality_missing');
    expect(validateMerchant(merchant({ address: { ...merchant().address, postalCode: '' } }))).toBe('address_postal_code_missing');
    expect(validateMerchant(merchant({ address: { ...merchant().address, streetAddress: '' } }))).toBe('address_street_missing');
  });
});

describe('records match the documented JSON samples', () => {
  it('entity', () => {
    expect(toEntity(merchant())).toEqual({
      entity_id: 'u-123',
      name: 'Acme Plumbing',
      telephone: '+14155550100',
      location: { address: { country: 'US', locality: 'San Francisco', region: 'CA', postal_code: '94103', street_address: '1 Market St' } },
    });
  });
  it('entity omits optional fields it cannot fill (no guessed phone/region)', () => {
    const e = toEntity(merchant({ phone: '555', address: { ...merchant().address, region: null } }));
    expect(e).not.toHaveProperty('telephone');
    expect(e.location.address).not.toHaveProperty('region');
  });
  it('action uses an empty appointment_info object and an https url', () => {
    expect(toAction(merchant())).toEqual({
      entity_id: 'u-123',
      link_id: 'u-123-book',
      url: 'https://app.vireek.com/book/acme',
      actions: [{ appointment_info: {} }],
    });
  });
});

describe('partitionMerchants', () => {
  it('separates invalid and duplicate merchants without dropping silently', () => {
    const { valid, rejected } = partitionMerchants([merchant(), merchant(), merchant({ entityId: 'u-2', name: '' })]);
    expect(valid).toHaveLength(1);
    expect(rejected).toEqual([{ entityId: 'u-123', reason: 'entity_id_duplicate' }, { entityId: 'u-2', reason: 'name_missing' }]);
  });
});

describe('buildFeedFiles', () => {
  it('builds timestamped data + descriptor files with the documented fileset names', () => {
    const files = buildFeedFiles('entity', [merchant()], 1677545962);
    expect(files.map((f) => f.name)).toEqual(['entity_1677545962_0001.json', 'entity_1677545962.filesetdesc.json']);
    expect(JSON.parse(files[1].content)).toEqual({ generation_timestamp: 1677545962, name: ENTITY_FILESET_NAME, data_file: ['entity_1677545962_0001.json'] });
    const a = buildFeedFiles('action', [merchant()], 1677540395);
    expect(JSON.parse(a[a.length - 1].content).name).toBe(ACTION_FILESET_NAME);
  });
  it('shards large feeds and lists every shard in the descriptor', () => {
    const many = Array.from({ length: 5 }, (_, i) => merchant({ entityId: `u-${i}` }));
    const files = buildFeedFiles('action', many, 10, { shardSize: 2 });
    expect(files.map((f) => f.name)).toEqual(['action_10_0001.json', 'action_10_0002.json', 'action_10_0003.json', 'action_10.filesetdesc.json']);
    expect(JSON.parse(files[2].content).data).toHaveLength(1);
  });
  it('an empty merchant list still yields one empty data file + descriptor (a valid full refresh)', () => {
    const files = buildFeedFiles('entity', [], 5);
    expect(files).toHaveLength(2);
    expect(JSON.parse(files[0].content)).toEqual({ data: [] });
  });
});
