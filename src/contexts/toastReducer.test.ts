import { describe, expect, it } from 'vitest';
import { MAX_VISIBLE, ToastItem, ToastType, defaultDuration, initialToastState, toastKey, toastReducer } from './toastReducer';

let n = 0;
const mk = (type: ToastType, message: string): ToastItem => ({
  id: `t${++n}`,
  key: toastKey(type, message),
  type,
  message,
  durationMs: 1000,
  count: 1,
  bump: 0,
});
const add = (s: typeof initialToastState, t: ToastItem) => toastReducer(s, { type: 'add', toast: t });

describe('toastReducer', () => {
  it('shows up to MAX_VISIBLE and queues the rest in order', () => {
    let s = initialToastState;
    for (let i = 0; i < 5; i++) s = add(s, mk('info', `m${i}`));
    expect(s.visible.map((t) => t.message)).toEqual(['m0', 'm1', 'm2']);
    expect(s.queue.map((t) => t.message)).toEqual(['m3', 'm4']);
    expect(s.visible.length).toBe(MAX_VISIBLE);
  });

  it('promotes from the queue when one is dismissed', () => {
    let s = initialToastState;
    for (let i = 0; i < 4; i++) s = add(s, mk('info', `m${i}`));
    s = toastReducer(s, { type: 'dismiss', id: s.visible[0].id });
    expect(s.visible.map((t) => t.message)).toEqual(['m1', 'm2', 'm3']);
    expect(s.queue).toEqual([]);
  });

  it('dedupes identical toasts: bumps count + timer token instead of stacking', () => {
    let s = add(initialToastState, mk('error', 'Could not save'));
    s = add(s, mk('error', 'Could not save'));
    s = add(s, mk('error', 'Could not save'));
    expect(s.visible).toHaveLength(1);
    expect(s.visible[0].count).toBe(3);
    expect(s.visible[0].bump).toBe(2);
  });

  it('same message with a different severity is NOT a duplicate', () => {
    let s = add(initialToastState, mk('info', 'Saved'));
    s = add(s, mk('error', 'Saved'));
    expect(s.visible).toHaveLength(2);
  });

  it('dedupes against queued toasts too', () => {
    let s = initialToastState;
    for (let i = 0; i < 3; i++) s = add(s, mk('info', `m${i}`));
    s = add(s, mk('info', 'queued'));
    s = add(s, mk('info', 'queued'));
    expect(s.queue).toHaveLength(1);
    expect(s.queue[0].count).toBe(2);
  });

  it('errors jump ahead of lower-severity queued toasts, but not ahead of other errors', () => {
    let s = initialToastState;
    for (let i = 0; i < 3; i++) s = add(s, mk('info', `m${i}`));
    s = add(s, mk('success', 'q-success'));
    s = add(s, mk('info', 'q-info'));
    s = add(s, mk('error', 'q-error-1'));
    s = add(s, mk('error', 'q-error-2'));
    expect(s.queue.map((t) => t.message)).toEqual(['q-error-1', 'q-error-2', 'q-info', 'q-success']);
  });

  it('dismissing an unknown id is a no-op and clear empties everything', () => {
    let s = add(initialToastState, mk('info', 'a'));
    expect(toastReducer(s, { type: 'dismiss', id: 'nope' }).visible).toHaveLength(1);
    s = toastReducer(s, { type: 'clear' });
    expect(s).toEqual(initialToastState);
  });
});

describe('defaultDuration (auto-dismiss rules by severity)', () => {
  it('orders by severity', () => {
    const d = (t: ToastType) => defaultDuration(t, 'short', false) as number;
    expect(d('success')).toBeLessThan(d('info'));
    expect(d('info')).toBeLessThan(d('warning'));
    expect(d('warning')).toBeLessThan(d('error'));
  });
  it('errors with an action never auto-dismiss; sticky never auto-dismisses', () => {
    expect(defaultDuration('error', 'x', true)).toBeNull();
    expect(defaultDuration('info', 'x', false, true)).toBeNull();
    expect(defaultDuration('success', 'x', true)).not.toBeNull();
  });
  it('longer messages stay longer, capped', () => {
    expect(defaultDuration('info', 'a'.repeat(120), false) as number).toBeGreaterThan(defaultDuration('info', 'a', false) as number);
    expect(defaultDuration('info', 'a'.repeat(5000), false)).toBe(5000 + 6000);
  });
});
