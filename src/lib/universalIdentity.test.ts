import { describe, it, expect } from 'vitest';
import {
  ENTITY_TYPES, ENTITY_TYPE_META, allowedTransitions, canTransition, confidenceLabel, coveragePercent, identityChecksum,
  identityErrorMessage, isTerminal, isValidIdentityUid, layoutGraph, looksLikeUid, normalizeDossier, normalizeEntity,
  normalizeGraph, normalizeOverview, normalizeSearch, parseAttributesInput, parseIdentityUid, relativeTime, shortUid,
  transitionNeedsReason, LIFECYCLE_STATES, type GraphNode, type LifecycleState,
} from './universalIdentity';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function makeUid(code: string, body: string): string {
  return `VRK-${code}-${body}-${identityChecksum(code + body)}`;
}
const BODY = '8F3K2M9QX7T4N6BA';

describe('universal ID', () => {
  it('accepts every entity type code with a correct checksum', () => {
    for (const t of ENTITY_TYPES) {
      const uid = makeUid(ENTITY_TYPE_META[t].code, BODY);
      expect(isValidIdentityUid(uid)).toBe(true);
      expect(parseIdentityUid(uid)?.type).toBe(t);
    }
  });

  it('normalises case and whitespace', () => {
    const uid = makeUid('EQP', BODY);
    expect(parseIdentityUid(`  ${uid.toLowerCase()}  `)?.body).toBe(BODY);
  });

  it('rejects a wrong checksum, wrong type code, bad alphabet and bad length', () => {
    const uid = makeUid('EQP', BODY);
    const last = uid.slice(-1);
    expect(isValidIdentityUid(uid.slice(0, -1) + (last === '0' ? '1' : '0'))).toBe(false);
    expect(isValidIdentityUid(uid.replace('EQP', 'XXX'))).toBe(false);
    expect(isValidIdentityUid(makeUid('EQP', BODY.replace('8', 'I')))).toBe(false); // I is not in Crockford base32
    expect(isValidIdentityUid(makeUid('EQP', BODY.slice(1)))).toBe(false);
    expect(isValidIdentityUid('')).toBe(false);
  });

  it('detects single-character corruption and adjacent transpositions of the body', () => {
    const uid = makeUid('PRP', BODY);
    const head = 'VRK-PRP-';
    const body = uid.slice(head.length, head.length + 16);
    const tail = uid.slice(head.length + 16);
    for (let i = 0; i < 16; i += 1) {
      const swapped = B32[(B32.indexOf(body[i]) + 1) % 32];
      expect(isValidIdentityUid(head + body.slice(0, i) + swapped + body.slice(i + 1) + tail)).toBe(false);
    }
    const t = body.split('');
    [t[0], t[1]] = [t[1], t[0]];
    expect(isValidIdentityUid(head + t.join('') + tail)).toBe(false);
  });

  it('shortens for display and detects uid-like queries', () => {
    expect(shortUid(makeUid('SVC', BODY))).toContain('8F3K…N6BA');
    expect(shortUid('nonsense')).toBe('nonsense');
    expect(looksLikeUid(' vrk-per-123')).toBe(true);
    expect(looksLikeUid('John')).toBe(false);
  });
});

describe('lifecycle', () => {
  it('matches the database state machine', () => {
    expect(allowedTransitions('draft')).toEqual(['active', 'retired']);
    expect(allowedTransitions('active')).toEqual(['suspended', 'disputed', 'retired']);
    expect(allowedTransitions('retired')).toEqual(['active']);
    expect(allowedTransitions('merged')).toEqual([]);
    expect(allowedTransitions('erased')).toEqual([]);
  });

  it('never offers merge or erase through the transition path, and never allows leaving a terminal state', () => {
    for (const from of LIFECYCLE_STATES) {
      const out = allowedTransitions(from as LifecycleState);
      expect(out).not.toContain('merged');
      expect(out).not.toContain('erased');
      if (isTerminal(from as LifecycleState)) expect(out).toHaveLength(0);
    }
    expect(canTransition('active', 'draft')).toBe(false);
  });

  it('requires a reason for state changes that restrict an entity', () => {
    expect(transitionNeedsReason('suspended')).toBe(true);
    expect(transitionNeedsReason('retired')).toBe(true);
    expect(transitionNeedsReason('active')).toBe(false);
  });
});

describe('normalisers', () => {
  it('normalizeEntity rejects junk and clamps values', () => {
    expect(normalizeEntity(null)).toBeNull();
    expect(normalizeEntity({ id: 'x', entity_type: 'spaceship' })).toBeNull();
    const e = normalizeEntity({ id: 'x', uid: 'u', entity_type: 'part', lifecycle_state: 'weird', confidence: 7, assurance: 'nope', attributes: [1] });
    expect(e?.lifecycle_state).toBe('active');
    expect(e?.confidence).toBe(1);
    expect(e?.assurance).toBe('unverified');
    expect(e?.attributes).toEqual({});
  });

  it('normalizeDossier survives garbage and picks the right label per direction', () => {
    expect(normalizeDossier(undefined).found).toBe(false);
    const d = normalizeDossier({
      found: true,
      entity: { id: 'e1', uid: 'u', entity_type: 'equipment' },
      relationships: [
        { id: 'r1', rel_type: 'owns', direction: 'in', label: 'owns', inverse_label: 'owned by', other_id: 'o1', other_name: 'Acme' },
        { id: 'r2', rel_type: 'located_at', direction: 'out', label: 'located at', inverse_label: 'hosts', other_id: 'o2' },
        { rel_type: 'broken' },
      ],
      events: [{ seq: 0 }, { seq: 2, event_type: 'created', diff_keys: ['a', 3] }],
    });
    expect(d.found).toBe(true);
    expect(d.relationships).toHaveLength(2);
    expect(d.relationships[0].label).toBe('owned by');
    expect(d.relationships[1].label).toBe('located at');
    expect(d.relationships[1].other_name).toBe('Restricted entity');
    expect(d.events).toHaveLength(1);
    expect(d.events[0].diff_keys).toEqual(['a']);
    expect(d.permissions.manage).toBe(false);
  });

  it('normalizeGraph drops nodes of unknown type and edges with missing endpoints', () => {
    const g = normalizeGraph({
      found: true, root_id: 'a',
      nodes: [{ id: 'a', entity_type: 'person' }, { id: 'b', entity_type: 'bogus' }, { id: 'c', entity_type: 'property', depth: 1 }],
      edges: [{ id: 'e1', src: 'a', dst: 'c' }, { id: 'e2', src: 'a', dst: 'b' }],
    });
    expect(g.nodes.map((n) => n.id)).toEqual(['a', 'c']);
    expect(g.edges.map((e) => e.id)).toEqual(['e1']);
  });

  it('normalizeSearch and normalizeOverview are defensive', () => {
    expect(normalizeSearch(null).items).toEqual([]);
    const o = normalizeOverview({ entities: 3, by_type: { person: 2, alien: 9 }, coverage: [{ key: 'customers', label: 'Customers', total: 4, registered: 2 }, { label: 'no key' }] });
    expect(o.by_type).toEqual({ person: 2 });
    expect(o.coverage).toHaveLength(1);
    expect(o.avg_confidence).toBeNull();
  });
});

describe('coverage, confidence, time', () => {
  it('computes coverage and never exceeds 100%', () => {
    expect(coveragePercent([])).toBe(100);
    expect(coveragePercent([{ key: 'a', label: 'A', total: 10, registered: 5 }, { key: 'b', label: 'B', total: 10, registered: 99 }])).toBe(75);
  });
  it('labels confidence bands', () => {
    expect(confidenceLabel(0.9)).toBe('High');
    expect(confidenceLabel(0.7)).toBe('Good');
    expect(confidenceLabel(0.5)).toBe('Fair');
    expect(confidenceLabel(0.1)).toBe('Low');
  });
  it('formats relative time', () => {
    const now = new Date('2027-01-10T12:00:00Z');
    expect(relativeTime('2027-01-10T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2027-01-10T10:00:00Z', now)).toBe('2 h ago');
    expect(relativeTime(null, now)).toBe('—');
    expect(relativeTime('garbage', now)).toBe('—');
  });
});

describe('layoutGraph', () => {
  const n = (id: string, depth: number, type: GraphNode['entity_type'] = 'person'): GraphNode =>
    ({ id, uid: id, entity_type: type, display_name: id, lifecycle_state: 'active', confidence: 0.5, depth });

  it('centres a lone root and is deterministic', () => {
    expect(layoutGraph([n('a', 0)], 600, 400)).toEqual([{ ...n('a', 0), x: 300, y: 200 }]);
    const nodes = [n('a', 0), n('b', 1, 'equipment'), n('c', 1, 'property'), n('d', 2)];
    expect(layoutGraph(nodes, 600, 400)).toEqual(layoutGraph([...nodes].reverse(), 600, 400));
  });

  it('keeps every node inside the viewport', () => {
    const nodes = [n('a', 0), ...Array.from({ length: 30 }, (_, i) => n(`n${i}`, (i % 3) + 1))];
    for (const p of layoutGraph(nodes, 600, 400)) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(600);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(400);
    }
    expect(layoutGraph([], 600, 400)).toEqual([]);
  });
});

describe('input & errors', () => {
  it('parses attribute JSON safely', () => {
    expect(parseAttributesInput('')).toEqual({ value: {} });
    expect(parseAttributesInput('{"a":1}')).toEqual({ value: { a: 1 } });
    expect('error' in parseAttributesInput('[1,2]')).toBe(true);
    expect('error' in parseAttributesInput('{bad')).toBe(true);
    expect('error' in parseAttributesInput(JSON.stringify({ big: 'x'.repeat(31000) }))).toBe(true);
  });
  it('maps server errors to safe messages without leaking SQL', () => {
    expect(identityErrorMessage({ message: 'cycle_detected' })).toMatch(/loop/);
    expect(identityErrorMessage({ message: 'ERROR: relation "x" does not exist' })).toBe('Something went wrong. Please try again.');
    expect(identityErrorMessage(null)).toBe('Something went wrong. Please try again.');
  });
});
