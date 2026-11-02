import { describe, expect, it } from 'vitest';
import { splitIntoChunks } from './speech';

describe('splitIntoChunks', () => {
  it('empty / whitespace', () => { expect(splitIntoChunks('  \n ')).toEqual([]); });
  it('keeps short text as one chunk and splits on sentences when too long', () => {
    expect(splitIntoChunks('Hello world. Bye.')).toEqual(['Hello world. Bye.']);
    const long = `${'a'.repeat(100)}. ${'b'.repeat(100)}.`;
    expect(splitIntoChunks(long, 150)).toHaveLength(2);
  });
  it('never exceeds max, even for one huge unbroken word', () => {
    const chunks = splitIntoChunks('x'.repeat(1000), 180);
    expect(chunks.every((c) => c.length <= 180)).toBe(true);
    expect(chunks.join('')).toBe('x'.repeat(1000));
  });
  it('handles Persian/Arabic sentence marks', () => {
    expect(splitIntoChunks(`${'الف '.repeat(30)}؟ ${'ب '.repeat(60)}.`, 120).every((c) => c.length <= 120)).toBe(true);
  });
});
