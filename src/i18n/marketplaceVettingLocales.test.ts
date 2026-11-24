import { describe, expect, it } from 'vitest';
import en from '@/locales/en/marketplaceVetting.json';
import fa from '@/locales/fa/marketplaceVetting.json';
import { BLOCKER_CODES, DELIST_REASONS } from '@/lib/marketplaceVetting';

type Json = { [k: string]: string | Json };

function flatten(obj: Json, prefix = ''): Record<string, string> {
  return Object.entries(obj).reduce<Record<string, string>>((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') acc[key] = v;
    else Object.assign(acc, flatten(v, key));
    return acc;
  }, {});
}

const flatEn = flatten(en as Json);
const flatFa = flatten(fa as Json);
const placeholders = (s: string) => (s.match(/{{\w+}}/g) ?? []).sort().join(',');

const CHECK_IDS = [
  'manifest.shape', 'manifest.limits', 'manifest.prompt', 'scopes.known', 'scopes.risk', 'scopes.coherence', 'outbound.endpoint',
  'outbound.host', 'outbound.dns', 'outbound.declared', 'data.exposure', 'data.messaging', 'identity.publisher', 'identity.lookalike',
];
const CHECKLIST = [
  'publisher_identity', 'security_contact', 'endpoint_control', 'signature_verification', 'scopes_justified', 'pii_minimisation',
  'subprocessors_match', 'dpa_in_place', 'sandbox_run_reviewed', 'sms_compliance', 'pricing_terms_clear', 'delisting_terms_ack',
];

describe('marketplaceVetting locale files', () => {
  it('Persian has exactly the English keys and no empty values', () => {
    expect(Object.keys(flatFa).sort()).toEqual(Object.keys(flatEn).sort());
    for (const [k, v] of Object.entries(flatFa)) expect(v.trim().length > 0, k).toBe(true);
  });
  it('placeholders match between languages', () => {
    for (const k of Object.keys(flatEn)) expect(placeholders(flatFa[k]), k).toBe(placeholders(flatEn[k]));
  });
  it('covers every blocker, delist reason, check title and checklist item', () => {
    for (const c of BLOCKER_CODES) expect(flatEn[`blockers.${c}`], c).toBeTruthy();
    for (const r of DELIST_REASONS) expect(flatEn[`reasons.${r}`], r).toBeTruthy();
    for (const id of CHECK_IDS) expect(flatEn[`checks.${id}.title`], id).toBeTruthy();
    for (const s of CHECKLIST) {
      expect(flatEn[`checklist.${s}.label`], s).toBeTruthy();
      expect(flatEn[`checklist.${s}.hint`], s).toBeTruthy();
    }
  });
});
