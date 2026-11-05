import { describe, expect, it } from 'vitest';
import { MASS_INCIDENT_RESOURCES } from './massIncidentNamespace';

describe('massIncident i18n', () => {
  it('Spanish has exactly the English keys and no empty values', () => {
    const en = Object.keys(MASS_INCIDENT_RESOURCES.en).sort();
    const es = Object.keys(MASS_INCIDENT_RESOURCES.es).sort();
    expect(es).toEqual(en);
    for (const v of Object.values(MASS_INCIDENT_RESOURCES.es)) expect(v.trim().length).toBeGreaterThan(0);
  });
  it('interpolation placeholders match across languages', () => {
    const ph = (s: string) => (s.match(/{{\w+}}/g) ?? []).sort().join(',');
    for (const k of Object.keys(MASS_INCIDENT_RESOURCES.en) as Array<keyof typeof MASS_INCIDENT_RESOURCES.en>) {
      expect(ph(MASS_INCIDENT_RESOURCES.es[k])).toBe(ph(MASS_INCIDENT_RESOURCES.en[k]));
    }
  });
});
