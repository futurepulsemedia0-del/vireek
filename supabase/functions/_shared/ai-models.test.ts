import { describe, it, expect, vi } from 'vitest';
import { MODELS, MODEL_REGISTRY, ALL_MODEL_IDS, getModelEntry, isRegisteredModel, resolveModel } from './ai-models';

const env = (m: Record<string, string>) => (n: string) => m[n];

describe('MODEL_REGISTRY integrity', () => {
  it('has unique ids and every MODELS value is registered exactly once', () => {
    expect(new Set(ALL_MODEL_IDS).size).toBe(ALL_MODEL_IDS.length);
    for (const id of Object.values(MODELS)) expect(ALL_MODEL_IDS.filter((x) => x === id)).toHaveLength(1);
    expect(MODEL_REGISTRY).toHaveLength(Object.keys(MODELS).length);
  });
  it('every entry has provider, purpose, owner and an explicit pinning story', () => {
    for (const e of MODEL_REGISTRY) {
      expect(e.provider, e.id).toBeTruthy();
      expect(e.purpose, e.id).toBeTruthy();
      expect(e.owner, e.id).toMatch(/^@/);
      if (e.pinning === 'snapshot') expect(e.pinnedVersion, e.id).toBeTruthy();
      if (e.pinning !== 'snapshot') expect(e.note ?? '', e.id).toMatch(/VERIFY|router/i);
    }
  });
  it('deprecated/retired entries name a registered replacement and a sunset date', () => {
    for (const e of MODEL_REGISTRY.filter((x) => x.status !== 'active')) {
      expect(e.replacedBy, e.id).toBeTruthy();
      expect(isRegisteredModel(e.replacedBy!), e.id).toBe(true);
      expect(e.sunsetDate, e.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it('lookup helpers', () => {
    expect(getModelEntry('gemini-2.5-flash')?.provider).toBe('gemini');
    expect(getModelEntry('nope')).toBeUndefined();
    expect(isRegisteredModel(MODELS.CLAUDE_SONNET)).toBe(true);
  });
});

describe('resolveModel', () => {
  it('uses the fallback when no override is set or it is blank', () => {
    expect(resolveModel(['GEMINI_MODEL'], MODELS.GEMINI_FLASH, env({}))).toBe('gemini-2.5-flash');
    expect(resolveModel(['GEMINI_MODEL'], MODELS.GEMINI_FLASH, env({ GEMINI_MODEL: '  ' }))).toBe('gemini-2.5-flash');
  });
  it('first non-empty env name wins, in order', () => {
    const g = env({ B_MODEL: 'gpt-4o-mini', C_MODEL: 'claude-sonnet-5' });
    expect(resolveModel(['A_MODEL', 'B_MODEL', 'C_MODEL'], MODELS.GEMINI_FLASH, g)).toBe('gpt-4o-mini');
  });
  it('registered override is returned silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveModel(['M'], MODELS.GEMINI_FLASH, env({ M: 'claude-sonnet-5' }))).toBe('claude-sonnet-5');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it('unregistered override still works (logged) unless AI_MODEL_REGISTRY_STRICT=1', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveModel(['M'], MODELS.GEMINI_FLASH, env({ M: 'gemini-9-ultra' }))).toBe('gemini-9-ultra');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(resolveModel(['M'], MODELS.GEMINI_FLASH, env({ M: 'gemini-9-ultra', AI_MODEL_REGISTRY_STRICT: '1' }))).toBe('gemini-2.5-flash');
    warn.mockRestore();
  });
});
