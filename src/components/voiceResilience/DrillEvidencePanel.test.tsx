// SSR render test for DrillEvidencePanel. UI primitives and icons are stand-ins so the panel's own markup/a11y wiring is under test.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import en from '@/locales/en/voiceResilience.json';
import { buildEvidenceLog, computeDrillStatus, type CheckRow } from '@/lib/voiceDrills';

const icon = () => null;
vi.mock('lucide-react', () => ({ AlertTriangle: icon, CheckCircle2: icon, ClipboardList: icon }));
vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, loading, loadingLabel: _l, variant: _v, size: _s, ...r }: Record<string, unknown> & { children?: unknown }) => <button {...(r as object)} data-loading={loading ? 'true' : undefined}>{children as never}</button>,
}));
vi.mock('@/components/ui/Card', () => ({ Card: ({ children, interactive: _i, ...r }: Record<string, unknown> & { children?: unknown }) => <div {...(r as object)}>{children as never}</div> }));
vi.mock('@/components/ui/Checkbox', () => ({ Checkbox: ({ label, ...r }: Record<string, unknown>) => <label><input type="checkbox" {...(r as object)} />{label as string}</label> }));
vi.mock('@/components/ui/Input', () => ({
  Input: ({ label, error, helperText: _h, ...r }: Record<string, unknown>) => <label>{label as string}<input {...(r as object)} />{error ? <span role="alert">{error as string}</span> : null}</label>,
  Textarea: ({ label, error, helperText: _h, ...r }: Record<string, unknown>) => <label>{label as string}<textarea {...(r as object)} />{error ? <span role="alert">{error as string}</span> : null}</label>,
}));
vi.mock('@/components/ui/Select', () => ({ Select: ({ label, children, ...r }: Record<string, unknown> & { children?: unknown }) => <label>{label as string}<select {...(r as object)}>{children as never}</select></label> }));

const { DrillEvidencePanel } = await import('./DrillEvidencePanel');

const get = (k: string): string | undefined => k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], en) as string | undefined;
const t = (k: string, o?: Record<string, unknown>) => (get(k) ?? `MISSING:${k}`).replace(/\{\{(\w+)\}\}/g, (_, n) => String(o?.[n] ?? ''));
const NOW = Date.parse('2026-11-19T12:00:00Z');
const sched = { enabled: true, interval_days: 30 };
const check = (id: string, status: CheckRow['status'], ago: number): CheckRow => ({ id, kind: 'forward_on', status, started_at: new Date(NOW - ago * 86_400_000).toISOString(), finished_at: new Date(NOW - ago * 86_400_000).toISOString() });
const base = (entries: ReturnType<typeof buildEvidenceLog>) => ({
  t, schedule: sched, status: computeDrillStatus(sched, entries, NOW), entries, formatDate: (s: string) => s.slice(0, 10),
  onSchedule: () => {}, onSaveSchedule: () => {}, savingSchedule: false, scheduleMessage: null,
  draft: { kind: 'voicemail' as const, outcome: 'passed' as const, note: '' }, draftError: null, onDraft: () => {}, onLog: () => {}, logging: false, logMessage: null, onGoToWizard: () => {},
});

describe('DrillEvidencePanel', () => {
  it('never-tested account: warning state with a run-now action, empty log, no missing keys', () => {
    const h = renderToStaticMarkup(<DrillEvidencePanel {...base([])} />);
    expect(h).toContain('No passed test call yet');
    expect(h).toContain('Run the test call');
    expect(h).toContain('Nothing recorded yet');
    expect(h).toContain('role="status"');
    expect(h).not.toContain('MISSING:');
  });
  it('verified account: ok state, no run-now button, accessible table with scoped headers', () => {
    const h = renderToStaticMarkup(<DrillEvidencePanel {...base(buildEvidenceLog([check('a', 'passed', 3)], []))} />);
    expect(h).toContain('Safety net verified');
    expect(h).not.toContain('Run the test call');
    expect(h).toContain('<caption class="sr-only">');
    expect(h.match(/scope="col"/g)).toHaveLength(4);
    expect(h).toContain('Verified by Vireek');
    expect(h).not.toContain('MISSING:');
  });
  it('overdue shows the last passed date; note error is announced as an alert', () => {
    const h = renderToStaticMarkup(<DrillEvidencePanel {...base(buildEvidenceLog([check('a', 'passed', 45)], []))} draftError="noteTooLong" />);
    expect(h).toContain('Test call overdue');
    expect(h).toContain('2026-10-05');
    expect(h).toContain('role="alert"');
  });
});
