import { describe, expect, it } from 'vitest';
import {
  ageBand,
  ageLabel,
  explainPattern,
  humanize,
  missingProfileFields,
  modelLabelFromKey,
  parseTags,
  prefillFromDiagnosis,
  slugify,
  strandsOf,
  type FailurePattern,
  type GenomeDna,
} from '@/lib/failureGenome';

const DNA: GenomeDna = {
  model: { key: 'carrier/24acc636/hvac', make: 'Carrier', model: '24ACC636', type: 'hvac' },
  age: { months: 50, band: '3-5y' },
  climate: { band: 'hot_humid' },
  usage: { band: 'unknown' },
  symptoms: ['hard_start', 'tripping_breaker'],
  history: { failures: 2, recurrences: 1, first_on: '2026-01-10', last_on: '2026-06-01', mean_months_between: 4.7, service_overdue: false },
  parts: ['run_capacitor'],
  failure: { components: [{ component: 'run_capacitor', count: 2 }], last: 'run_capacitor' },
  repair: { actions: [{ action: 'replace_component', count: 2 }], last: 'replace_component' },
  outcome: { fixed: 1, recurred: 1, callback: 0, replaced_unit: 0, deferred: 0, unknown: 0, last: 'recurred' },
};

describe('slugify / parseTags', () => {
  it('normalises free text to the same slug the database produces', () => {
    expect(slugify('  Run Capacitor!! ')).toBe('run_capacitor');
    expect(slugify('Hard-Start / Tripping')).toBe('hard_start_tripping');
    expect(slugify('   ')).toBeNull();
    expect(slugify(null)).toBeNull();
  });

  it('parses, de-duplicates, sorts and caps tag lists', () => {
    expect(parseTags('Hard Start, tripping breaker; hard start\nNoisy')).toEqual(['hard_start', 'noisy', 'tripping_breaker']);
    expect(parseTags('a,b,c,d', 2)).toHaveLength(2);
  });
});

describe('age helpers', () => {
  it('bands match fg_age_band() thresholds', () => {
    expect(ageBand(null)).toBe('unknown');
    expect(ageBand(35)).toBe('0-2y');
    expect(ageBand(36)).toBe('3-5y');
    expect(ageBand(107)).toBe('6-8y');
    expect(ageBand(155)).toBe('9-12y');
    expect(ageBand(156)).toBe('13y+');
  });

  it('formats age labels', () => {
    expect(ageLabel(null)).toBe('Unknown');
    expect(ageLabel(8)).toBe('8m');
    expect(ageLabel(24)).toBe('2y');
    expect(ageLabel(50)).toBe('4y 2m');
  });
});

describe('strandsOf', () => {
  it('always returns the 10 strands in canonical order', () => {
    expect(strandsOf(DNA).map((s) => s.key)).toEqual([
      'model', 'age', 'climate', 'usage', 'symptoms', 'history', 'parts', 'failure', 'repair', 'outcome',
    ]);
  });

  it('marks unset profile strands and reports what is missing', () => {
    const usage = strandsOf(DNA).find((s) => s.key === 'usage');
    expect(usage?.filled).toBe(false);
    expect(usage?.value).toBe('Not set');
    expect(missingProfileFields(DNA)).toEqual(['usage']);
  });

  it('describes a unit with no failures without inventing history', () => {
    const empty: GenomeDna = {
      ...DNA,
      symptoms: [],
      parts: [],
      history: { ...DNA.history, failures: 0, recurrences: 0, last_on: null },
      failure: { components: [], last: null },
      repair: { actions: [], last: null },
      outcome: { fixed: 0, recurred: 0, callback: 0, replaced_unit: 0, deferred: 0, unknown: 0, last: null },
    };
    const byKey = Object.fromEntries(strandsOf(empty).map((s) => [s.key, s]));
    expect(byKey.history.value).toBe('No failures logged');
    expect(byKey.failure.filled).toBe(false);
    expect(byKey.outcome.value).toBe('—');
  });
});

describe('pattern copy', () => {
  const pattern: FailurePattern = {
    id: 'p1', model_key: 'carrier/24acc636/hvac', make_key: 'carrier', type_key: 'hvac',
    failure_component: 'run_capacitor', age_band: '3-5y', climate_band: 'hot_humid',
    units_exposed: 120, contributor_count: 9, recent_events: 14, baseline_events: 12,
    recent_rate: 11.67, baseline_rate: 3.33, lift: 3.5, z_score: 4.9, status: 'emerging',
    recurrence_rate: 0.2, replacement_rate: 0.05, fix_rate: 0.7, avg_repair_cost: 310,
    top_symptoms: [], top_parts: [], top_repairs: [], window_days: 90,
    first_detected_at: null, status_changed_at: '2026-10-01T00:00:00Z',
  };

  it('explains why a pattern was flagged, with the expected baseline', () => {
    const text = explainPattern(pattern);
    expect(text).toContain('14 run capacitor failures in the last 90 days');
    expect(text).toContain('120 Carrier 24ACC636 (hvac) units');
    expect(text).toContain('aged 3-5y in hot humid climates');
    expect(text).toContain('about 4 expected');
  });

  it('builds a readable model label and humanizes slugs', () => {
    expect(modelLabelFromKey('carrier/24acc636/hvac')).toBe('Carrier 24ACC636 (hvac)');
    expect(humanize('hot_humid')).toBe('Hot humid');
    expect(humanize(null)).toBe('—');
  });
});

describe('prefillFromDiagnosis', () => {
  it('turns the top cause and likely parts into editable suggestions', () => {
    const pre = prefillFromDiagnosis({
      id: 'd1', created_at: '2026-09-01', symptoms: 'Unit hums but will not start',
      ai_result: {
        probable_causes: [{ cause: 'Failed run capacitor' }],
        parts_needed: [{ name: 'Run capacitor', necessity: 'likely' }, { name: 'Contactor', necessity: 'possible' }],
      },
    });
    expect(pre.component).toBe('failed run capacitor');
    expect(pre.parts).toBe('Run capacitor');
    expect(pre.notes).toContain('hums');
  });
});
