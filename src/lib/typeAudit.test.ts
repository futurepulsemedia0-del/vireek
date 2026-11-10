import { describe, it, expect, afterEach } from 'vitest';
import { findSmallText } from './typeAudit';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('findSmallText', () => {
  it('flags text below the floor and ignores text at or above it', () => {
    document.body.innerHTML = '<p id="a" style="font-size:11px">tiny</p><p style="font-size:12px">ok</p><p style="font-size:14px">fine</p>';
    const hits = findSmallText(document, 12);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ selector: 'p#a', px: 11, text: 'tiny' });
  });
  it('skips hidden text and elements without their own text', () => {
    document.body.innerHTML = '<div style="font-size:9px"><span style="display:none;font-size:9px">hidden</span></div>';
    expect(findSmallText()).toEqual([]);
  });
  it('ignores non-rendered SVG tooltips (<title>/<desc>) but still sees real SVG text', () => {
    document.body.innerHTML = '<svg viewBox="0 0 10 10"><title style="font-size:5px">tip</title><text style="font-size:8px">label</text></svg>';
    const hits = findSmallText(document, 12);
    expect(hits.map((h) => h.selector.split('.')[0])).toEqual(['text']);
  });
  it('honours a custom floor', () => {
    document.body.innerHTML = '<p style="font-size:13px">x</p>';
    expect(findSmallText(document, 14)).toHaveLength(1);
    expect(findSmallText(document, 12)).toHaveLength(0);
  });
  it('is self-contained (safe to pass to page.evaluate): references no module-level identifiers', () => {
    const src = findSmallText.toString();
    expect(src).not.toMatch(/\bimport\b|__vite|_a\./);
  });
});
