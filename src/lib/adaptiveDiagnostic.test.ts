import { describe, it, expect } from 'vitest';
import { accuracyChange, confidenceLabel, diagnosticMessage, friendlyDiagError, pct, progressPercent } from './adaptiveDiagnostic';

describe('adaptiveDiagnostic helpers', () => {
  it('formats percentages and confidence', () => {
    expect(pct(0.826)).toBe('83%');
    expect(pct(null)).toBe('—');
    expect(confidenceLabel(0.8)).toBe('High');
    expect(confidenceLabel(0.55)).toBe('Medium');
    expect(confidenceLabel(0.2)).toBe('Low');
  });
  it('keeps progress inside a sensible range', () => {
    expect(progressPercent(0, 5)).toBe(4);
    expect(progressPercent(5, 5)).toBe(96);
    expect(progressPercent(2, 4)).toBe(50);
  });
  it('reports accuracy change only with enough evidence', () => {
    expect(accuracyChange([{ bucket: 0, n: 10, accuracy: 0.6, avg_questions: 6 }])).toBeNull();
    expect(
      accuracyChange([
        { bucket: 0, n: 10, accuracy: 0.6, avg_questions: 6 },
        { bucket: 1, n: 10, accuracy: 0.74, avg_questions: 5 },
      ]),
    ).toEqual({ first: 0.6, latest: 0.74, deltaPp: 14 });
  });
  it('builds a customer message and extracts database errors', () => {
    expect(diagnosticMessage('Acme HVAC', 'https://x/diagnose/1')).toContain('Acme HVAC');
    expect(friendlyDiagError(new Error('DIAG_ALREADY_CONFIRMED: this outcome was already recorded'))).toBe('this outcome was already recorded');
    expect(friendlyDiagError(new Error('boom'), 'fallback')).toBe('fallback');
  });
});
