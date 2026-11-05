// SSR render tests for the presentational panels. UI primitives and icons are replaced by thin stand-ins so the
// panels' own markup/a11y wiring is what's under test (the real primitives have their own tests/suite).
import { describe, expect, it, mock } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import en from '@/locales/en/voiceResilience.json';

const icon = () => null;
mock.module('lucide-react', () => ({ AlertTriangle: icon, CheckCircle2: icon, PhoneForwarded: icon, RefreshCw: icon, ShieldAlert: icon, Info: icon }));
mock.module('@/components/ui/Button', () => ({
  Button: ({ children, disabled, disabledReason, loading, loadingLabel: _l, variant: _v, size: _s, ...r }: Record<string, unknown> & { children?: unknown }) =>
    <button {...(r as object)} data-disabled={disabled ? 'true' : undefined} data-reason={disabledReason as string} data-loading={loading ? 'true' : undefined}>{children as never}</button>,
}));
mock.module('@/components/ui/Card', () => ({ Card: ({ children, interactive: _i, ...r }: Record<string, unknown> & { children?: unknown }) => <div {...(r as object)}>{children as never}</div> }));
mock.module('@/components/ui/CopyButton', () => ({ CopyButton: ({ text }: { text: string }) => <button data-copy={text}>copy</button> }));
mock.module('@/components/ui/Checkbox', () => ({ Checkbox: ({ label, helperText: _h, ...r }: Record<string, unknown>) => <label><input type="checkbox" {...(r as object)} />{label as string}</label> }));
mock.module('@/components/ui/Input', () => ({
  Input: ({ label, error, helperText: _h, ...r }: Record<string, unknown>) => <label>{label as string}<input {...(r as object)} aria-invalid={!!error} />{error ? <span role="alert">{error as string}</span> : null}</label>,
  Textarea: ({ label, error, helperText: _h, ...r }: Record<string, unknown>) => <label>{label as string}<textarea {...(r as object)} aria-invalid={!!error} />{error ? <span role="alert">{error as string}</span> : null}</label>,
}));
mock.module('@/components/ui/Select', () => ({ Select: ({ label, children, ...r }: Record<string, unknown> & { children?: unknown }) => <label>{label as string}<select {...(r as object)}>{children as never}</select></label> }));

const { LadderStatusPanel } = await import('./LadderStatusPanel');
const { BackupSettingsPanel } = await import('./BackupSettingsPanel');
const { CarrierWizardPanel } = await import('./CarrierWizardPanel');
const { draftFromSettings } = await import('@/lib/voiceResilience');

// Resolves keys against the real English bundle with {{x}} interpolation, so a missing key shows up as the key itself.
const get = (k: string): string | undefined => k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], en) as string | undefined;
const t = (k: string, o?: Record<string, unknown>) => (get(k) ?? `MISSING:${k}`).replace(/\{\{(\w+)\}\}/g, (_, n) => String(o?.[n] ?? ''));
const html = (el: JSX.Element) => renderToStaticMarkup(el);
const fmt = (s: string) => s;
const NOW = Date.parse('2026-11-05T10:00:00Z');
const baseStatus = { org: null, platform_level: 0 as const, since: null, recent_fallback_calls: [], checks: [] };

describe('LadderStatusPanel', () => {
  it('shows level as text, marks current step, live region present, empty state', () => {
    const h = html(<LadderStatusPanel t={t} status={{ ...baseStatus, platform_level: 2 }} now={NOW} onRefresh={() => {}} formatDate={fmt} />);
    expect(h).toContain('Level 2');
    expect(h).toContain('Degraded');
    expect(h).toContain('role="status"');
    expect(h.match(/aria-current="step"/g)).toHaveLength(1);
    expect(h).toContain('No backup-handled calls');
    expect(h).not.toContain('MISSING:');
  });
  it('org pin overrides platform level and explains it', () => {
    const org = { user_id: 'u', forced_level: 3 as const, forced_until: '2026-11-05T11:00:00Z', reduced_assistant_id: null, static_message: null, language: 'en' as const, forward_numbers: [], front_door_enabled: false, alert_sms: true };
    const h = html(<LadderStatusPanel t={t} status={{ ...baseStatus, org }} now={NOW} onRefresh={() => {}} formatDate={fmt} />);
    expect(h).toContain('Level 3');
    expect(h).toContain('Your account is set to level 3 until 2026-11-05T11:00:00Z');
  });
  it('renders accessible table with emergency marker', () => {
    const h = html(<LadderStatusPanel t={t} status={{ ...baseStatus, recent_fallback_calls: [{ call_sid: 'CA1', level: 3, outcome: 'emergency_forwarded', is_emergency: true, created_at: '2026-11-05T09:00:00Z' }] }} now={NOW} onRefresh={() => {}} formatDate={fmt} />);
    expect(h).toContain('<caption class="sr-only">');
    expect(h).toContain('scope="col"');
    expect(h).toContain('Emergency connected to your team');
    expect(h).toContain('>Emergency<');
    expect(h).not.toContain('MISSING:');
  });
});

describe('BackupSettingsPanel', () => {
  const ov = { level: 3 as const, minutes: 60, active: false, busy: false, onLevel: () => {}, onMinutes: () => {}, onApply: () => {}, onClear: () => {}, message: null };
  const props = { t, draft: draftFromSettings(null), errors: {}, onChange: () => {}, onSave: () => {}, saving: false, message: null, override: ov };
  it('renders all fields, five level options, no clear button when inactive', () => {
    const h = html(<BackupSettingsPanel {...props} />);
    expect(h.match(/<option/g)?.length).toBe(2 + 5);
    expect(h).not.toContain('Return to automatic');
    expect(h).not.toContain('MISSING:');
  });
  it('shows clear when pinned and surfaces field errors + alert message', () => {
    const h = html(<BackupSettingsPanel {...props} errors={{ forwardNumbers: { key: 'forwardInvalid', values: { list: 'abc' } } }} message={{ tone: 'error', text: 'Boom' }} override={{ ...ov, active: true }} />);
    expect(h).toContain('Return to automatic');
    expect(h).toContain("These aren&#x27;t valid phone numbers: abc");
    expect(h).toContain('aria-invalid="true"');
    expect(h).toContain('role="alert"');
  });
});

describe('CarrierWizardPanel', () => {
  const base = { t, family: 'gsm_standard' as const, onFamily: () => {}, numbers: ['+14155552671'], number: '+14155552671', onNumber: () => {}, businessNumber: '', onBusinessNumber: () => {}, plan: null, planLoading: false, onLoadPlan: () => {}, check: null, onStart: () => {}, errorKey: null };
  it('empty state when the account has no Vireek number', () => {
    const h = html(<CarrierWizardPanel {...base} numbers={[]} number="" />);
    expect(h).toContain('No Vireek number yet');
    expect(h).not.toContain('Prove it works');
  });
  it('test buttons disabled with a reason until a business line is entered', () => {
    const h = html(<CarrierWizardPanel {...base} />);
    expect(h.match(/data-disabled="true"/g)).toHaveLength(2);
    expect(h).not.toContain('MISSING:');
  });
  it('renders dial codes with copy, and honest guidance when no universal code exists', () => {
    const plan = { warning: 'Confirm with carrier', codes: [
      { kind: 'no_answer' as const, activate: '**61*+14155552671**20#', cancel: '##61#', status: '*#61#', confidence: 'standard' as const, note: '' },
      { kind: 'busy' as const, activate: '', cancel: '', status: null, confidence: 'ask_carrier' as const, note: 'PBX only' },
    ] };
    const h = html(<CarrierWizardPanel {...base} plan={plan} />);
    expect(h).toContain('data-copy="**61*+14155552671**20#"');
    expect(h).toContain('dir="ltr"');
    expect(h).toContain('No universal code exists');
    expect(h.match(/data-copy=/g)).toHaveLength(3);
  });
  it.each([
    ['pending', 'Test call in progress', false],
    ['passed', 'Forwarding works', false],
    ['failed', 'The call did not reach Vireek', true],
    ['answered_by_human', 'Your phone was answered', true],
    ['expired', "We couldn&#x27;t confirm the result", true],
    ['error', 'The test call failed', true],
  ] as const)('result %s', (status, title, retry) => {
    const h = html(<CarrierWizardPanel {...base} businessNumber="+14155550100" check={{ kind: 'forward_on', status, elapsedSeconds: 12 }} />);
    expect(h).toContain(title);
    expect(h.includes('Try again')).toBe(retry);
    expect(h).toContain('aria-live="polite"');
    if (status === 'pending') expect(h).toContain('Waiting for the result… 12 s');
  });
  it('disables both test buttons while running and shows error text', () => {
    const h = html(<CarrierWizardPanel {...base} businessNumber="+14155550100" check={{ kind: 'forward_on', status: 'starting', elapsedSeconds: 0 }} errorKey="errors.tooMany" />);
    expect(h.match(/data-disabled="true"/g)).toHaveLength(2);
    expect(h).toContain('Placing the test call…');
    expect(h).toContain('Too many test calls this hour');
  });
});
