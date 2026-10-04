import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  describeDrift,
  formatRequirementLines,
  groupByKind,
  isKnownAt,
  isValidIsoDate,
  parseRequirementLines,
  proofLevel,
  resolveAsOf,
  segmentContains,
  slugifyKey,
  todayIso,
  validateVersionDraft,
  type ResolvedEntry,
  type SnapshotReport,
} from './temporalRegulation';

type V = Parameters<typeof resolveAsOf>[0][number];

function ver(p: Partial<V> & { effective_from: string; recorded_at: string }): V {
  return { expires_on: null, is_repeal: false, retracted_at: null, ...p };
}

describe('dates', () => {
  it('validates strict ISO calendar dates', () => {
    expect(isValidIsoDate('2026-05-17')).toBe(true);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('17/05/2026')).toBe(false);
    expect(isValidIsoDate(null)).toBe(false);
  });

  it('formats local today without timezone drift', () => {
    expect(todayIso(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('slugifyKey', () => {
  it('produces database-safe keys', () => {
    expect(slugifyKey('  NEC 2023 — Article 625  ')).toBe('nec-2023-article-625');
    expect(slugifyKey('A'.repeat(120)).length).toBe(80);
  });
});

describe('resolveAsOf (valid time)', () => {
  const v1 = ver({ effective_from: '2020-01-01', recorded_at: '2020-01-02T00:00:00Z' });
  const v2 = ver({ effective_from: '2024-07-01', recorded_at: '2024-06-01T00:00:00Z' });
  const now = '2027-01-01T00:00:00Z';

  it('picks the latest version at or before the date', () => {
    expect(resolveAsOf([v1, v2], '2023-12-31', now).version).toBe(v1);
    expect(resolveAsOf([v1, v2], '2024-07-01', now).version).toBe(v2);
    expect(resolveAsOf([v1, v2], '2026-05-17', now).status).toBe('in_force');
  });

  it('returns none before the first version', () => {
    expect(resolveAsOf([v1, v2], '2019-12-31', now)).toEqual({ version: null, status: 'none' });
  });

  it('treats a repeal tombstone as not in force and a later version as re-enacted', () => {
    const repeal = ver({ effective_from: '2025-01-01', recorded_at: '2024-12-01T00:00:00Z', is_repeal: true });
    expect(resolveAsOf([v1, repeal], '2025-06-01', now).status).toBe('repealed');
    const back = ver({ effective_from: '2026-01-01', recorded_at: '2025-12-01T00:00:00Z' });
    expect(resolveAsOf([v1, repeal, back], '2026-06-01', now).status).toBe('in_force');
  });

  it('treats an expired version as not in force', () => {
    const temp = ver({ effective_from: '2022-01-01', expires_on: '2022-06-01', recorded_at: '2021-12-01T00:00:00Z' });
    expect(resolveAsOf([temp], '2022-05-31', now).status).toBe('in_force');
    expect(resolveAsOf([temp], '2022-06-01', now).status).toBe('expired');
  });
});

describe('resolveAsOf (transaction time)', () => {
  const original = ver({ effective_from: '2024-01-01', recorded_at: '2024-01-05T00:00:00Z' });
  const correction = ver({ effective_from: '2024-01-01', recorded_at: '2026-03-01T00:00:00Z' });

  it('shows what we knew then vs now for a late correction', () => {
    expect(resolveAsOf([original, correction], '2025-01-01', '2025-06-01T00:00:00Z').version).toBe(original);
    expect(resolveAsOf([original, correction], '2025-01-01', '2026-06-01T00:00:00Z').version).toBe(correction);
  });

  it('ignores versions recorded after the knowledge date, and honours retraction time', () => {
    const wrong = ver({
      effective_from: '2024-01-01',
      recorded_at: '2024-01-05T00:00:00Z',
      retracted_at: '2025-01-01T00:00:00Z',
    });
    expect(isKnownAt(wrong, '2024-06-01T00:00:00Z')).toBe(true);
    expect(isKnownAt(wrong, '2025-06-01T00:00:00Z')).toBe(false);
    expect(resolveAsOf([wrong], '2024-06-01', '2023-01-01T00:00:00Z').status).toBe('none');
  });
});

describe('buildTimeline', () => {
  const now = '2027-01-01T00:00:00Z';

  it('builds contiguous segments and an open end', () => {
    const t = buildTimeline(
      [
        ver({ effective_from: '2020-01-01', recorded_at: '2020-01-01T00:00:00Z' }),
        ver({ effective_from: '2024-01-01', recorded_at: '2024-01-01T00:00:00Z' }),
      ],
      now,
    );
    expect(t.map((s) => [s.from, s.to])).toEqual([
      ['2020-01-01', '2024-01-01'],
      ['2024-01-01', null],
    ]);
  });

  it('inserts a gap after an expiry and marks repeals', () => {
    const t = buildTimeline(
      [
        ver({ effective_from: '2020-01-01', expires_on: '2021-01-01', recorded_at: '2020-01-01T00:00:00Z' }),
        ver({ effective_from: '2023-01-01', is_repeal: true, recorded_at: '2023-01-01T00:00:00Z' }),
      ],
      now,
    );
    expect(t.map((s) => s.status)).toEqual(['in_force', 'gap', 'repealed']);
    expect(segmentContains(t[1], '2022-01-01')).toBe(true);
    expect(segmentContains(t[0], '2021-01-01')).toBe(false);
  });

  it('keeps only the latest recording per effective date (corrections replace)', () => {
    const t = buildTimeline(
      [
        ver({ effective_from: '2024-01-01', recorded_at: '2024-01-01T00:00:00Z' }),
        ver({ effective_from: '2024-01-01', recorded_at: '2025-01-01T00:00:00Z' }),
      ],
      now,
    );
    expect(t).toHaveLength(1);
    expect(t[0].version?.recorded_at).toBe('2025-01-01T00:00:00Z');
  });
});

describe('requirement lines', () => {
  it('parses severity, title and detail, dropping empty lines', () => {
    const r = parseRequirementLines('[blocker] Pull permit | before work starts\n\nPhoto of panel\n[warning]   \n[INFO] Note');
    expect(r).toEqual([
      { title: 'Pull permit', detail: 'before work starts', severity: 'blocker' },
      { title: 'Photo of panel', severity: 'info' },
      { title: 'Note', severity: 'info' },
    ]);
  });

  it('round-trips through format', () => {
    const reqs = parseRequirementLines('[warning] A | b | c');
    expect(parseRequirementLines(formatRequirementLines(reqs))).toEqual(reqs);
  });

  it('caps at 40 requirements', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Item ${i}`).join('\n');
    expect(parseRequirementLines(text)).toHaveLength(40);
  });
});

describe('validateVersionDraft', () => {
  const base = {
    effectiveFrom: '2026-05-17',
    expiresOn: '',
    isRepeal: false,
    title: 'Permit required',
    summary: 'Pull a permit.',
    citation: 'City Code §12.3',
    sourceUrl: '',
    requirementsText: '',
  };

  it('accepts a complete draft', () => {
    expect(validateVersionDraft(base).ok).toBe(true);
  });

  it('requires a legal source', () => {
    const r = validateVersionDraft({ ...base, citation: '', sourceUrl: '' });
    expect(r.ok).toBe(false);
    expect(r.errors.citation).toBeDefined();
  });

  it('rejects an end date on or before the start and bad links', () => {
    expect(validateVersionDraft({ ...base, expiresOn: '2026-05-17' }).errors.expiresOn).toBeDefined();
    expect(validateVersionDraft({ ...base, sourceUrl: 'ftp://x' }).errors.sourceUrl).toBeDefined();
  });

  it('allows a repeal without title or summary', () => {
    expect(validateVersionDraft({ ...base, isRepeal: true, title: '', summary: '' }).ok).toBe(true);
  });
});

function entry(p: Partial<ResolvedEntry> & { kind: ResolvedEntry['kind']; key: string }): ResolvedEntry {
  return {
    node_id: p.key,
    title: p.key,
    authority: null,
    jurisdiction_code: 'US-TX',
    jurisdiction_name: 'Texas',
    inherited: false,
    version_id: `${p.key}-v`,
    version_no: 1,
    label: null,
    effective_from: '2020-01-01',
    expires_on: null,
    status: 'in_force',
    summary: null,
    requirements: [],
    citation: null,
    source_url: null,
    source_type: 'other',
    verification_status: 'verified',
    content_hash: 'h',
    recorded_at: '2020-01-01T00:00:00Z',
    ...p,
  };
}

describe('groupByKind', () => {
  it('orders groups along the regulatory chain and drops empty ones', () => {
    const g = groupByKind([
      entry({ kind: 'inspection', key: 'a' }),
      entry({ kind: 'code', key: 'b' }),
      entry({ kind: 'permit', key: 'c' }),
    ]);
    expect(g.map((x) => x.kind)).toEqual(['code', 'permit', 'inspection']);
  });
});

describe('proofLevel / describeDrift', () => {
  const snap = (over: Partial<SnapshotReport['snapshots'][number]> = {}): SnapshotReport['snapshots'][number] => ({
    id: '1',
    seq: 1,
    as_of: '2026-05-17',
    as_of_basis: 'manual',
    known_at: '2026-05-17T00:00:00Z',
    jurisdiction_code: 'US-TX',
    jurisdiction_label: 'Texas',
    work_types: [],
    reason: null,
    snapshot_hash: 'x',
    created_at: '2026-05-17T00:00:00Z',
    entries: [],
    versions_intact: true,
    drifted: false,
    drift: [],
    ...over,
  });

  it('classifies sealed, drifted and tampered records', () => {
    const ok = { chain_ok: true, broken_at_seq: null };
    expect(proofLevel(null)).toBe('none');
    expect(proofLevel({ snapshots: [snap()], integrity: ok })).toBe('sealed');
    expect(proofLevel({ snapshots: [snap({ drifted: true })], integrity: ok })).toBe('drifted');
    expect(proofLevel({ snapshots: [snap({ drifted: true })], integrity: { chain_ok: false, broken_at_seq: 1 } })).toBe('tampered');
    expect(proofLevel({ snapshots: [snap({ versions_intact: false })], integrity: ok })).toBe('tampered');
  });

  it('describes drift changes in plain words', () => {
    expect(describeDrift({ key: 'k', was_version: 1, now_version: 2, was_status: 'in_force', now_status: 'in_force' })).toBe('k: v1 → v2');
    expect(describeDrift({ key: 'k', was_version: 1, now_version: 1, was_status: 'in_force', now_status: 'repealed' })).toBe(
      'k: now repealed (was v1)',
    );
    expect(describeDrift({ key: 'k', was_version: null, now_version: 3, was_status: null, now_status: 'in_force' })).toBe(
      'k: newly recorded (v3)',
    );
  });
});
