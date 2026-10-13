import { describe, it, expect } from 'vitest';
import { activeTurnIndex, buildSentimentTimeline, estimateSentiment, findMatches, formatClock, parseTranscript, splitHighlight } from './callDetail';

const SAMPLE =
  'Sarah: Thank you for calling BluePipe Plumbing. How can I help?\n' +
  'Caller: I have water pouring out from under my sink, I am so stressed!\n' +
  'Sarah: I am dispatching a plumber now. Can you give me your address?\n' +
  'Caller: 248 Oak Street, apartment 3B.\n' +
  'Sarah: Got it. Stay safe.\n' +
  'Caller: Thank you so much, I really appreciate it. That sounds good.';

describe('parseTranscript', () => {
  it('splits into speaker turns and assigns roles', () => {
    const turns = parseTranscript(SAMPLE, 120, 'Dana Whitfield');
    expect(turns).toHaveLength(6);
    expect(turns.map((t) => t.role)).toEqual(['agent', 'caller', 'agent', 'caller', 'agent', 'caller']);
    expect(turns[1].speaker).toBe('Caller');
  });

  it('estimates increasing audio positions across the call duration', () => {
    const turns = parseTranscript(SAMPLE, 120);
    expect(turns[0].approxStartSec).toBe(0);
    const times = turns.map((t) => t.approxStartSec as number);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times[5]).toBeLessThan(120);
    expect(parseTranscript(SAMPLE, null)[2].approxStartSec).toBeNull();
  });

  it('does not treat "Address: ..." inside a sentence as a speaker change', () => {
    const turns = parseTranscript('Caller: My details are\nAddress: 12 Oak St\nAgent: Thanks', 30);
    expect(turns).toHaveLength(2);
    expect(turns[0].text).toBe('My details are Address: 12 Oak St');
  });

  it('recognises the caller by name and handles unlabeled / empty text', () => {
    expect(parseTranscript('Dana: hi\nSarah: hello\nDana: bye', 10, 'Dana Whitfield').map((t) => t.role)).toEqual(['caller', 'agent', 'caller']);
    expect(parseTranscript('just some words', 10)[0].role).toBe('unknown');
    expect(parseTranscript('   ', 10)).toEqual([]);
    expect(parseTranscript(null, 10)).toEqual([]);
  });

  it('finds the active turn from the playback position', () => {
    const turns = parseTranscript(SAMPLE, 120);
    expect(activeTurnIndex(turns, 0)).toBe(0);
    expect(activeTurnIndex(turns, 119)).toBe(5);
    expect(activeTurnIndex(parseTranscript(SAMPLE, null), 5)).toBe(-1);
  });
});

describe('search', () => {
  const turns = parseTranscript(SAMPLE, 120);
  it('counts matches per turn, case-insensitively', () => {
    expect(findMatches(turns, 'ADDRESS')).toEqual([{ turnIndex: 2, count: 1 }]);
    expect(findMatches(turns, 'thank').map((m) => m.turnIndex)).toEqual([0, 5]);
    expect(findMatches(turns, '   ')).toEqual([]);
  });

  it('splits highlights safely, even for regex metacharacters', () => {
    expect(splitHighlight('Fix the (AC) now', '(ac)')).toEqual([
      { text: 'Fix the ', match: false },
      { text: '(AC)', match: true },
      { text: ' now', match: false },
    ]);
    expect(splitHighlight('hello', '')).toEqual([{ text: 'hello', match: false }]);
  });
});

describe('sentiment', () => {
  it('scores positive, negative and negated wording', () => {
    expect(estimateSentiment('Thank you, that is perfect, I really appreciate it').label).toBe('positive');
    expect(estimateSentiment('This is terrible, I am furious and want to cancel').label).toBe('negative');
    expect(estimateSentiment('That is not good').score).toBeLessThan(0);
    expect(estimateSentiment('No problem at all').score).toBeGreaterThan(0);
    expect(estimateSentiment('My address is 248 Oak Street').label).toBe('neutral');
  });

  it('builds a caller-only timeline with an improving trend and a lowest point', () => {
    const s = buildSentimentTimeline(parseTranscript(SAMPLE, 120));
    expect(s.points.map((p) => p.turnIndex)).toEqual([1, 3, 5]);
    expect(s.trend).toBe('improving');
    expect(s.lowest?.turnIndex).toBe(1);
  });

  it('returns an empty summary when the caller never speaks', () => {
    expect(buildSentimentTimeline(parseTranscript('Sarah: hello', 10))).toEqual({ points: [], average: null, trend: null, lowest: null });
  });

  it('formats clock values', () => {
    expect(formatClock(125)).toBe('2:05');
    expect(formatClock(null)).toBe('0:00');
  });
});
