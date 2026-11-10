// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { checkText, checkRepo, checkEmInvariants, loadAllowlist } from './check-text-sizes.mjs';

const rules = (text, ext = '.tsx', rel = 'src/x.tsx', allow = {}) => checkText(text, ext, rel, allow).map((v) => v.rule);

describe('guard rules', () => {
  it('R1: every arbitrary text size, any unit', () => {
    expect(rules('text-[14px]')).toContain('R1');
    expect(rules('text-[1rem]')).toContain('R1');
    expect(rules('text-[0.9em]')).toContain('R1');
  });
  it('R2: anything below 12px in any form', () => {
    expect(rules('text-[11px]')).toEqual(expect.arrayContaining(['R1', 'R2']));
    expect(rules('<span style={{ fontSize: 11 }} />')).toContain('R2');
    expect(rules('<text fontSize="9">a</text>')).toContain('R2');
    expect(rules('a{font-size:0.6875rem}', '.css', 'src/a.css')).toContain('R2');
    expect(rules('a{font-size:clamp(10px,2vw,16px)}', '.css', 'src/a.css')).toContain('R2');
    expect(rules("style={{ font: '400 10px system-ui' }}")).toContain('R2');
  });
  it('R3: px font sizes in CSS/inline styles, but rem is fine', () => {
    expect(rules('a{font-size:14px}', '.css', 'src/a.css')).toEqual(['R3']);
    expect(rules('<i style={{ fontSize: 14 }} />')).toEqual(['R3']);
    expect(rules('a{font-size:0.875rem}', '.css', 'src/a.css')).toEqual([]);
  });
  it('R4: literal SVG fontSize; svgSize(...) is fine', () => {
    expect(rules('<text fontSize={14}>a</text>')).toEqual(['R4']);
    expect(rules('<text fontSize={svgSize(10)}>a</text>')).toEqual([]);
  });
  it('compliant code passes', () => {
    expect(rules('<p className="text-caption text-small md:text-body text-h2 type-figure" />')).toEqual([]);
  });
  it('allowlist waives R1/R3/R4 but NEVER the 12px floor', () => {
    const allow = { 'src/x.tsx': { allow: ['em', 'px', 'svg'] } };
    expect(rules('text-[1.2em]', '.tsx', 'src/x.tsx', allow)).toEqual([]);
    expect(rules('<i style={{ fontSize: 16 }} />', '.tsx', 'src/x.tsx', allow)).toEqual([]);
    expect(rules('<text fontSize="16">a</text>', '.tsx', 'src/x.tsx', allow)).toEqual([]);
    expect(rules('<i style={{ fontSize: 10 }} />', '.tsx', 'src/x.tsx', allow)).toEqual(['R2']);
    expect(rules('text-[9px]', '.tsx', 'src/x.tsx', allow)).toEqual(expect.arrayContaining(['R1', 'R2']));
  });
  it('an allowlist for another file does not apply', () => {
    expect(rules('text-[1.2em]', '.tsx', 'src/y.tsx', { 'src/x.tsx': { allow: ['em'] } })).toContain('R1');
  });
  it('type-ok comment waives a single line', () => {
    expect(rules('const a = "text-[11px]"; // type-ok: legacy embed')).toEqual([]);
  });
});

describe('the repository', () => {
  it('has ZERO violations (arbitrary sizes, sub-12px, px, literal svg sizes, broken allowlist invariants)', () => {
    const { violations, scanned } = checkRepo();
    expect(scanned).toBeGreaterThan(1000);
    expect(violations.map((v) => `${v.rule} ${v.file}:${v.line} ${v.snippet}`)).toEqual([]);
  });
  it('every allowlist entry has a reason and an invariant, and names an existing file', () => {
    for (const [file, e] of Object.entries(loadAllowlist())) {
      expect(e.reason?.length, file).toBeGreaterThan(20);
      expect(e.invariant?.length, file).toBeGreaterThan(10);
      expect(e.allow?.length, file).toBeGreaterThan(0);
      expect(e.allow.every((k) => ['em', 'px', 'svg'].includes(k)), file).toBe(true);
    }
  });
  it('em invariants hold', () => expect(checkEmInvariants()).toEqual([]));
});
