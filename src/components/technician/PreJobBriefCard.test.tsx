import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import i18next from 'i18next';
import en from '@/locales/en/voiceLog.json';
import type { JobBrief } from '@/lib/technicianOS';

vi.mock('@/i18n/voiceLogNamespace', () => ({
  useVoiceLogT: () => ({ t: i18next.getFixedT('en', 'voiceLog'), language: 'en' }),
}));
import { PreJobBriefCard } from './PreJobBriefCard';

const brief = (job: Record<string, unknown> = {}): JobBrief => ({
  job: { id: 'j', customer_name: 'Ann', service_type: 'AC repair', safety_flag: true, safety_flag_note: 'Gas smell reported', job_status: 'en_route', ...job },
  customer: { name: 'Ann Lee' },
  equipment: [{ make: 'Trane', model: 'XR14', equipment_type: 'AC', install_date: '2019-05-01', warranty_expires_at: '2099-01-01' }],
  previous_notes: [], warranty_claims: [], likely_diagnosis: null, customer_preferences: [], parts_check: [],
} as unknown as JobBrief);

const speak = vi.fn();
const cancel = vi.fn();

beforeEach(async () => {
  await i18next.init({ lng: 'en', resources: { en: { voiceLog: en } }, ns: ['voiceLog'], defaultNS: 'voiceLog', interpolation: { escapeValue: false } });
  vi.stubGlobal('SpeechSynthesisUtterance', class { text: string; lang = ''; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(t: string) { this.text = t; } });
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak, cancel } });
});
afterEach(() => { cleanup(); speak.mockClear(); cancel.mockClear(); vi.unstubAllGlobals(); });

describe('PreJobBriefCard', () => {
  it('lists the safety note first and labels it as a team note, not instructions', () => {
    render(<PreJobBriefCard brief={brief()} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toContain('Gas smell reported');
    expect(items[0].textContent).toContain('not verified instructions');
  });
  it('shows the "arriving soon" heading when en route', () => {
    render(<PreJobBriefCard brief={brief()} />);
    expect(screen.getByRole('heading', { name: /Arriving soon/ })).toBeTruthy();
  });
  it('reads aloud only after the technician taps the button, and can stop', () => {
    render(<PreJobBriefCard brief={brief()} />);
    expect(speak).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Read it to me' }));
    expect(speak).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Stop reading' }));
    expect(cancel).toHaveBeenCalled();
  });
  it('renders nothing for an error payload', () => {
    const { container } = render(<PreJobBriefCard brief={{ error: 'forbidden' } as unknown as JobBrief} />);
    expect(container.textContent).toBe('');
  });
  it('has no axe violations (contrast is covered by the Playwright run)', async () => {
    const { container } = render(<PreJobBriefCard brief={brief()} />);
    const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(res.violations).toEqual([]);
  });
});
