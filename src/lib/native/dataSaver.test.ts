import { describe, expect, it } from 'vitest';
import { parseDataSaverPref, shouldSaveData } from './dataSaver';

describe('data saver', () => {
  it('defaults to auto for unknown values', () => {
    expect(parseDataSaverPref(null)).toBe('auto');
    expect(parseDataSaverPref('banana')).toBe('auto');
    expect(parseDataSaverPref('on')).toBe('on');
  });
  it('auto follows Save-Data and 2G', () => {
    expect(shouldSaveData('auto', { saveData: true })).toBe(true);
    expect(shouldSaveData('auto', { effectiveType: '2g' })).toBe(true);
    expect(shouldSaveData('auto', { effectiveType: '4g' })).toBe(false);
  });
  it('user choice wins over the network hint', () => {
    expect(shouldSaveData('off', { saveData: true })).toBe(false);
    expect(shouldSaveData('on', { effectiveType: '4g' })).toBe(true);
  });
});
