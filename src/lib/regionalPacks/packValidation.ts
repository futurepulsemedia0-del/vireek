/* ------------------------------------------------------------------ */
/*  Phone, address and tax-id validation per country.                  */
/*  Structural validation only (no network): it catches typos and      */
/*  wrong-country input; it cannot prove a number is in service or an  */
/*  address exists. Plug a verifier (VIES, address API) in on top.     */
/* ------------------------------------------------------------------ */
import { COUNTRY_PROFILES, getCountry } from './packData';
import type { TaxScheme } from './packTypes';

/* ================================ PHONE ============================== */

export type PhoneType = 'mobile' | 'fixed' | 'toll_free' | 'premium' | 'unknown';
export interface PhoneResult {
  ok: boolean;
  e164?: string;
  country?: string;
  national?: string;
  international?: string;
  type?: PhoneType;
  reason?: string;
}

const CODE_TO_COUNTRIES: Record<string, string[]> = {};
for (const c of Object.values(COUNTRY_PROFILES)) {
  (CODE_TO_COUNTRIES[c.phone.callingCode] ??= []).push(c.code);
}

/** Canadian NANP area codes. Everything else in +1 resolves to the US (or the account's default country). */
const CA_AREA_CODES = new Set([
  '204', '226', '236', '249', '250', '257', '263', '289', '306', '343', '354', '365', '367', '368', '382', '403', '416', '418',
  '428', '431', '437', '438', '450', '468', '474', '506', '514', '519', '548', '579', '581', '584', '587', '604', '613', '639',
  '647', '672', '683', '705', '709', '742', '753', '778', '780', '782', '807', '819', '825', '867', '873', '879', '902', '905', '942',
]);
const NANP_TOLL_FREE = new Set(['800', '833', '844', '855', '866', '877', '888']);

const MOBILE_HINTS: Record<string, RegExp> = {
  FR: /^[67]\d{8}$/, ES: /^[67]\d{8}$/, IT: /^3\d{8,9}$/, NL: /^6\d{8}$/, DE: /^1[567]\d{8,9}$/,
  IE: /^8[35-9]\d{7}$/, AT: /^6\d{8,11}$/, SE: /^7[0236]\d{7}$/,
};

function chunk(s: string, sizes: number[]): string {
  const parts: string[] = [];
  let i = 0;
  for (const n of sizes) { if (i >= s.length) break; parts.push(s.slice(i, i + n)); i += n; }
  if (i < s.length) parts.push(s.slice(i));
  return parts.join(' ');
}

function gbGroup(nsn: string): string {
  if (nsn.startsWith('2')) return chunk(nsn, [2, 4, 4]);
  if (/^1\d1/.test(nsn)) return chunk(nsn, [3, 3, 4]);
  if (/^[389]/.test(nsn)) return chunk(nsn, [3, 3, 4]);
  return nsn.length === 10 ? chunk(nsn, [4, 6]) : chunk(nsn, [5, 4]);
}

function formatNsn(country: string, nsn: string, type: PhoneType): { national: string; intl: string } {
  const cc = COUNTRY_PROFILES[country].phone.callingCode;
  if (country === 'US' || country === 'CA') {
    return { national: `(${nsn.slice(0, 3)}) ${nsn.slice(3, 6)}-${nsn.slice(6)}`, intl: `+1 ${nsn.slice(0, 3)} ${nsn.slice(3, 6)} ${nsn.slice(6)}` };
  }
  if (country === 'GB') {
    const g = gbGroup(nsn);
    return { national: `0${g}`, intl: `+44 ${g}` };
  }
  if (country === 'AU') {
    if (/^1[38]00/.test(nsn)) { const g = chunk(nsn, [4, 3, 3]); return { national: g, intl: `+61 ${g}` }; }
    if (type === 'mobile') { const g = chunk(nsn, [3, 3, 3]); return { national: `0${nsn.slice(0, 3)} ${nsn.slice(3, 6)} ${nsn.slice(6)}`, intl: `+61 ${g}` }; }
    return { national: `(0${nsn[0]}) ${nsn.slice(1, 5)} ${nsn.slice(5)}`, intl: `+61 ${nsn[0]} ${nsn.slice(1, 5)} ${nsn.slice(5)}` };
  }
  const trunk = COUNTRY_PROFILES[country].phone.trunk;
  const g = country === 'FR' ? `${nsn[0]} ${nsn.slice(1).replace(/(\d{2})(?=\d)/g, '$1 ')}` : chunk(nsn, [3, 3, 3]);
  return { national: `${trunk}${g}`.trim(), intl: `+${cc} ${g}` };
}

export function parsePhone(raw: string, defaultCountry: string): PhoneResult {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'Enter a phone number.' };
  const s = raw.trim().replace(/(?:ext\.?|extension|x|#)\s*\d{1,6}$/i, '').trim();
  if (/[A-Za-z]/.test(s)) return { ok: false, reason: 'Phone numbers can only contain digits and + ( ) - . spaces.' };
  const hadPlus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return { ok: false, reason: 'Enter a phone number.' };

  let country: string | null = null;
  let nsn = '';
  const fallback = getCountry(defaultCountry);

  if (hadPlus || digits.startsWith('00')) {
    if (!hadPlus) digits = digits.slice(2);
    const code = [1, 2, 3].map((n) => digits.slice(0, n)).find((c) => CODE_TO_COUNTRIES[c]);
    if (!code) return { ok: false, reason: 'Unsupported or unknown country calling code.' };
    nsn = digits.slice(code.length);
    const candidates = CODE_TO_COUNTRIES[code];
    country = candidates.length === 1 ? candidates[0]
      : (CA_AREA_CODES.has(nsn.slice(0, 3)) ? 'CA' : candidates.includes(defaultCountry.toUpperCase()) ? defaultCountry.toUpperCase() : 'US');
    if (code === '1' && CA_AREA_CODES.has(nsn.slice(0, 3))) country = 'CA';
  } else {
    if (!fallback) return { ok: false, reason: 'Add the country code (e.g. +44…) or set a default country.' };
    country = fallback.code;
    nsn = digits;
    const { callingCode, trunk } = fallback.phone;
    if (callingCode === '1') { if (nsn.length === 11 && nsn.startsWith('1')) nsn = nsn.slice(1); }
    else if (trunk && nsn.startsWith(trunk)) nsn = nsn.slice(trunk.length);
    if (CA_AREA_CODES.has(nsn.slice(0, 3)) && callingCode === '1') country = 'CA';
  }

  const profile = COUNTRY_PROFILES[country];
  const { minLen, maxLen } = profile.phone;
  let type: PhoneType = 'unknown';

  if (profile.phone.callingCode === '1') {
    if (nsn.length !== 10) return { ok: false, reason: 'North American numbers have 10 digits (area code + 7).' };
    const [npa, nxx] = [nsn.slice(0, 3), nsn.slice(3, 6)];
    if (!/^[2-9]\d{2}$/.test(npa) || /^\d11$/.test(npa)) return { ok: false, reason: 'That area code is not valid.' };
    if (!/^[2-9]\d{2}$/.test(nxx) || /^\d11$/.test(nxx)) return { ok: false, reason: 'That exchange code is not valid.' };
    type = NANP_TOLL_FREE.has(npa) ? 'toll_free' : npa === '900' ? 'premium' : 'unknown';
  } else if (country === 'GB') {
    if (nsn.length < 9 || nsn.length > 10 || nsn.startsWith('0')) return { ok: false, reason: 'UK numbers have 9–10 digits after the 0.' };
    if (/^7[1-57-9]\d{8}$/.test(nsn)) type = 'mobile';
    else if (/^80[08]\d{6,7}$/.test(nsn)) type = 'toll_free';
    else if (/^9[01]\d{7,8}$/.test(nsn)) type = 'premium';
    else if (/^[123]/.test(nsn)) type = 'fixed';
    else return { ok: false, reason: 'That UK number range is not valid.' };
  } else if (country === 'AU') {
    if (/^1[38]00\d{6}$/.test(nsn)) type = 'toll_free';
    else if (nsn.length !== 9) return { ok: false, reason: 'Australian numbers have 9 digits after the 0.' };
    else if (/^4\d{8}$/.test(nsn)) type = 'mobile';
    else if (/^[2378]\d{8}$/.test(nsn)) type = 'fixed';
    else return { ok: false, reason: 'That Australian number range is not valid.' };
  } else {
    if (nsn.length < minLen || nsn.length > maxLen) {
      return { ok: false, reason: minLen === maxLen ? `${profile.name} numbers have ${minLen} digits.` : `${profile.name} numbers have ${minLen}–${maxLen} digits.` };
    }
    if (MOBILE_HINTS[country]?.test(nsn)) type = 'mobile';
  }

  const f = formatNsn(country, nsn, type);
  return { ok: true, e164: `+${profile.phone.callingCode}${nsn}`, country, national: f.national, international: f.intl, type };
}

/** True only for numbers that can receive SMS (blocks landlines/toll-free for text campaigns). */
export function canReceiveSms(r: PhoneResult): boolean {
  if (!r.ok) return false;
  if (r.type === 'fixed' || r.type === 'toll_free' || r.type === 'premium') return false;
  return true; // mobile or undetermined (NANP/EU numbers cannot be classified offline)
}

/* ============================== ADDRESS ============================== */

export interface AddressInput {
  line1?: string; line2?: string; city?: string; subdivision?: string; postalCode?: string; country?: string;
}
export interface AddressIssue {
  field: keyof AddressInput;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}
export interface AddressResult { valid: boolean; normalized: AddressInput; issues: AddressIssue[] }

const clean = (v: string | undefined, max: number) => (v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const CA_FIRST_LETTER: Record<string, string[]> = {
  A: ['NL'], B: ['NS'], C: ['PE'], E: ['NB'], G: ['QC'], H: ['QC'], J: ['QC'], K: ['ON'], L: ['ON'], M: ['ON'], N: ['ON'], P: ['ON'],
  R: ['MB'], S: ['SK'], T: ['AB'], V: ['BC'], X: ['NT', 'NU'], Y: ['YT'],
};

export function auStateForPostcode(pc: string): string[] {
  const n = Number(pc);
  if (!Number.isInteger(n)) return [];
  if ((n >= 200 && n <= 299) || (n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920)) return ['ACT'];
  if ((n >= 1000 && n <= 2599) || (n >= 2619 && n <= 2899) || (n >= 2921 && n <= 2999)) return ['NSW'];
  if ((n >= 3000 && n <= 3999) || (n >= 8000 && n <= 8999)) return ['VIC'];
  if ((n >= 4000 && n <= 4999) || (n >= 9000 && n <= 9999)) return ['QLD'];
  if (n >= 5000 && n <= 5999) return ['SA'];
  if ((n >= 6000 && n <= 6797) || (n >= 6800 && n <= 6999)) return ['WA'];
  if (n >= 7000 && n <= 7999) return ['TAS'];
  if (n >= 800 && n <= 999) return ['NT'];
  return [];
}

function normalizePostal(country: string, raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  const compact = s.replace(/[\s-]/g, '');
  switch (country) {
    case 'CA': return /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact) ? `${compact.slice(0, 3)} ${compact.slice(3)}` : s;
    case 'GB': return /^[A-Z0-9]{5,7}$/.test(compact) ? `${compact.slice(0, -3)} ${compact.slice(-3)}` : s;
    case 'IE': return /^[A-Z0-9]{7}$/.test(compact) ? `${compact.slice(0, 3)} ${compact.slice(3)}` : s;
    case 'NL': return /^\d{4}[A-Z]{2}$/.test(compact) ? `${compact.slice(0, 4)} ${compact.slice(4)}` : s;
    case 'PL': return /^\d{5}$/.test(compact) ? `${compact.slice(0, 2)}-${compact.slice(2)}` : s;
    case 'PT': return /^\d{7}$/.test(compact) ? `${compact.slice(0, 4)}-${compact.slice(4)}` : s;
    default: return s;
  }
}

function resolveSubdivision(table: Readonly<Record<string, string>>, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const code = v.toUpperCase();
  if (table[code]) return code;
  const byName = Object.entries(table).find(([, name]) => name.toLowerCase() === v.toLowerCase());
  return byName ? byName[0] : null;
}

export function validateAddress(input: AddressInput, opts: { serviceSite?: boolean } = {}): AddressResult {
  const issues: AddressIssue[] = [];
  const err = (field: keyof AddressInput, code: string, message: string) => issues.push({ field, severity: 'error', code, message });
  const warn = (field: keyof AddressInput, code: string, message: string) => issues.push({ field, severity: 'warning', code, message });

  const n: AddressInput = {
    line1: clean(input.line1, 100), line2: clean(input.line2, 100), city: clean(input.city, 60),
    subdivision: clean(input.subdivision, 40), postalCode: clean(input.postalCode, 12), country: clean(input.country, 2).toUpperCase(),
  };

  const profile = getCountry(n.country);
  if (!n.country) { err('country', 'COUNTRY_REQUIRED', 'Choose a country.'); return { valid: false, normalized: n, issues }; }
  if (!profile) { err('country', 'COUNTRY_UNSUPPORTED', `${n.country} is not covered by an enabled regional pack.`); return { valid: false, normalized: n, issues }; }

  if (!n.line1 || n.line1.length < 3) err('line1', 'LINE1_REQUIRED', 'Enter the street address.');
  if (opts.serviceSite && /\bP\.?\s?O\.?\s?Box\b|\bpostbus\b|\bcase postale\b|\bapartado\b/i.test(`${n.line1} ${n.line2}`)) {
    warn('line1', 'PO_BOX_SITE', 'A PO box cannot be a service location — a technician needs a street address.');
  }
  if (!n.city) err('city', 'CITY_REQUIRED', 'Enter the city or town.');

  if (profile.subdivisions) {
    const code = resolveSubdivision(profile.subdivisions, n.subdivision ?? '');
    if (code) n.subdivision = code;
    else if (profile.subdivisionRequired) err('subdivision', 'SUBDIVISION_INVALID', `Choose a valid ${n.country === 'CA' ? 'province' : n.country === 'AU' ? 'state' : 'state'}.`);
    else if (n.subdivision) warn('subdivision', 'SUBDIVISION_UNKNOWN', 'Region not recognised.');
  }

  if (!n.postalCode) err('postalCode', 'POSTAL_REQUIRED', `Enter the ${profile.postal.label.toLowerCase()}.`);
  else {
    n.postalCode = normalizePostal(profile.code, n.postalCode);
    if (!profile.postal.regex.test(n.postalCode)) err('postalCode', 'POSTAL_INVALID', `${profile.postal.label} looks wrong — expected a format like ${profile.postal.example}.`);
    else if (n.subdivision) {
      const expected = profile.code === 'CA' ? CA_FIRST_LETTER[n.postalCode[0]] : profile.code === 'AU' ? auStateForPostcode(n.postalCode) : null;
      if (expected && expected.length && !expected.includes(n.subdivision)) {
        warn('postalCode', 'POSTAL_REGION_MISMATCH', `This ${profile.postal.label.toLowerCase()} usually belongs to ${expected.join('/')}, not ${n.subdivision}. Check for a typo.`);
      }
    }
  }
  return { valid: !issues.some((i) => i.severity === 'error'), normalized: n, issues };
}

/* ============================== TAX IDs ============================== */

export interface TaxIdResult {
  valid: boolean;
  normalized: string;
  country: string;
  scheme?: TaxScheme;
  checksum: 'passed' | 'failed' | 'not_applicable';
  warnings: string[];
  reason?: string;
}

const EU_VAT_FORMAT: Record<string, RegExp> = {
  AT: /^ATU\d{8}$/, BE: /^BE[01]\d{9}$/, BG: /^BG\d{9,10}$/, HR: /^HR\d{11}$/, CY: /^CY\d{8}[A-Z]$/, CZ: /^CZ\d{8,10}$/,
  DE: /^DE\d{9}$/, DK: /^DK\d{8}$/, EE: /^EE\d{9}$/, GR: /^EL\d{9}$/, ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/, FI: /^FI\d{8}$/,
  FR: /^FR[A-Z0-9]{2}\d{9}$/, HU: /^HU\d{8}$/, IE: /^IE(\d{7}[A-Z]{1,2}|\d[A-Z+*]\d{5}[A-Z])$/, IT: /^IT\d{11}$/,
  LT: /^LT(\d{9}|\d{12})$/, LU: /^LU\d{8}$/, LV: /^LV\d{11}$/, MT: /^MT\d{8}$/, NL: /^NL\d{9}B\d{2}$/, PL: /^PL\d{10}$/,
  PT: /^PT\d{9}$/, RO: /^RO\d{2,10}$/, SK: /^SK\d{10}$/, SI: /^SI\d{8}$/, SE: /^SE\d{10}01$/,
};

export function gbVatChecksumOk(digits9: string): boolean {
  if (!/^\d{9}$/.test(digits9)) return false;
  const w = [8, 7, 6, 5, 4, 3, 2];
  const total = w.reduce((a, wt, i) => a + wt * Number(digits9[i]), 0);
  const check = Number(digits9.slice(7));
  return (total + check) % 97 === 0 || (total + 55 + check) % 97 === 0;
}

export function abnChecksumOk(abn: string): boolean {
  if (!/^\d{11}$/.test(abn)) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const d = abn.split('').map(Number);
  d[0] -= 1;
  return d.reduce((a, n, i) => a + n * w[i], 0) % 89 === 0;
}

export function luhnOk(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function validateTaxId(country: string, raw: string, scheme?: TaxScheme): TaxIdResult {
  const cc = country.trim().toUpperCase();
  const base = { country: cc, checksum: 'not_applicable' as const, warnings: [] as string[] };
  const norm = (raw ?? '').toUpperCase().replace(/[\s.]/g, '');
  const bad = (reason: string, extra: Partial<TaxIdResult> = {}): TaxIdResult => ({ ...base, valid: false, normalized: norm, reason, ...extra });

  if (!norm) return bad('Enter a registration number.');
  const profile = getCountry(cc);
  if (!profile) return bad(`No regional pack covers ${cc}.`);

  if (profile.pack === 'EU') {
    let id = norm.replace(/-/g, '');
    const prefix = profile.vat!.idPrefix;
    if (!id.startsWith(prefix)) id = prefix + id;
    const re = EU_VAT_FORMAT[cc];
    if (!re.test(id)) return bad(`Not a valid ${profile.name} VAT number format.`, { normalized: id, scheme: 'VAT' });
    return { ...base, valid: true, normalized: id, scheme: 'VAT', warnings: ['Format checked only. Confirm the number in VIES before applying a cross-border reverse charge.'] };
  }

  if (cc === 'GB') {
    let id = norm.replace(/-/g, '');
    if (!id.startsWith('GB')) id = 'GB' + id;
    if (/^GB(GD\d{3}|HA\d{3})$/.test(id)) return { ...base, valid: true, normalized: id, scheme: 'VAT' };
    const m = /^GB(\d{9})(\d{3})?$/.exec(id);
    if (!m) return bad('UK VAT numbers are GB + 9 digits (12 for branches).', { scheme: 'VAT' });
    const ok = gbVatChecksumOk(m[1]);
    return ok
      ? { ...base, valid: true, normalized: id, scheme: 'VAT', checksum: 'passed' }
      : bad('This UK VAT number fails its checksum — check for a typo.', { scheme: 'VAT', checksum: 'failed', normalized: id });
  }

  if (cc === 'AU') {
    const digits = norm.replace(/\D/g, '');
    if (digits.length !== 11) return bad('An ABN has 11 digits.', { scheme: 'AU_GST' });
    return abnChecksumOk(digits)
      ? { ...base, valid: true, normalized: digits, scheme: 'AU_GST', checksum: 'passed' }
      : bad('This ABN fails its checksum — check for a typo.', { scheme: 'AU_GST', checksum: 'failed', normalized: digits });
  }

  if (cc === 'CA') {
    const s = scheme ?? 'GST_HST';
    const id = norm.replace(/[-]/g, '');
    if (s === 'GST_HST') {
      const m = /^(\d{9})RT(\d{4})$/.exec(id);
      if (!m) return bad('GST/HST numbers look like 123456789 RT 0001.', { scheme: s });
      const luhn = luhnOk(m[1]);
      return { ...base, valid: true, normalized: id, scheme: s, checksum: luhn ? 'passed' : 'failed',
        warnings: luhn ? ['Confirm the number with the CRA “Validate a GST/HST number” service.'] : ['The business number checksum does not match — double-check, then confirm with the CRA.'] };
    }
    if (s === 'QST') {
      return /^\d{10}TQ\d{4}$/.test(id)
        ? { ...base, valid: true, normalized: id, scheme: s, warnings: ['Confirm the QST number with Revenu Québec.'] }
        : bad('QST numbers look like 1234567890 TQ 0001.', { scheme: s });
    }
    return /^[A-Z0-9-]{6,20}$/.test(norm)
      ? { ...base, valid: true, normalized: norm, scheme: s, warnings: ['Provincial sales-tax numbers vary by province; confirm with the provincial authority.'] }
      : bad('Enter the provincial sales-tax number as issued.', { scheme: s });
  }

  return { ...base, valid: norm.length >= 3, normalized: norm, scheme: 'US_SALES_TAX', reason: norm.length >= 3 ? undefined : 'Too short.', warnings: ['US sales-tax permit formats differ by state and are not format-checked.'] };
}
