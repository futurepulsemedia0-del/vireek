import { describe, expect, it } from 'vitest';
import en from '@/locales/en/aiIncidents.json';
import fa from '@/locales/fa/aiIncidents.json';
import {
  AI_INCIDENT_OWNER_ROLES, AI_INCIDENT_SEVERITIES, AI_INCIDENT_SOURCES, AI_INCIDENT_STATUSES, AI_INCIDENT_TYPES, AI_NOTIFICATION_STATES,
} from '@/lib/aiIncidents';

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

describe('aiIncidents locale files', () => {
  it('Persian has exactly the English keys and no empty values', () => {
    expect(Object.keys(flatFa).sort()).toEqual(Object.keys(flatEn).sort());
    for (const v of Object.values(flatFa)) expect(v.trim().length).toBeGreaterThan(0);
  });

  it('interpolation placeholders match across languages', () => {
    for (const k of Object.keys(flatEn)) expect(placeholders(flatFa[k])).toBe(placeholders(flatEn[k]));
  });

  it('every enum value used by the page has a label in each language', () => {
    const groups: Array<[string, readonly string[]]> = [
      ['types', AI_INCIDENT_TYPES], ['severities', AI_INCIDENT_SEVERITIES], ['statuses', AI_INCIDENT_STATUSES],
      ['roles', AI_INCIDENT_OWNER_ROLES], ['sources', AI_INCIDENT_SOURCES], ['notice', AI_NOTIFICATION_STATES],
    ];
    for (const [ns, values] of groups) {
      for (const v of values) {
        expect(flatEn[`${ns}.${v}`], `en ${ns}.${v}`).toBeTruthy();
        expect(flatFa[`${ns}.${v}`], `fa ${ns}.${v}`).toBeTruthy();
      }
    }
  });

  it('every validation error key the code can produce is translated', () => {
    for (const k of ['required', 'tooShort', 'tooLong', 'email', 'future', 'invalid', 'forbidden', 'pii', 'postmortemRequired', 'generic']) {
      expect(flatEn[`errors.${k}`], `en errors.${k}`).toBeTruthy();
      expect(flatFa[`errors.${k}`], `fa errors.${k}`).toBeTruthy();
    }
  });
});
