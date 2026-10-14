import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  auth: {
    user: null as { id: string } | null,
    profile: null as { id: string; preferred_language?: string | null } | null,
  },
  a11y: { language: 'en', setLanguage: vi.fn() },
  eq: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/contexts/AccessibilityContext', () => ({ useAccessibility: () => h.a11y }));
vi.mock('@/lib/supabase', () => ({
  supabase: { from: vi.fn(() => ({ update: h.update })) },
}));

import { LanguagePersistenceSync } from './LanguagePersistenceSync';

const signIn = (remote: string | null) => {
  h.auth.user = { id: 'u1' };
  h.auth.profile = { id: 'u1', preferred_language: remote };
};

beforeEach(() => {
  h.auth.user = null;
  h.auth.profile = null;
  h.a11y.language = 'en';
  h.a11y.setLanguage.mockReset();
  h.eq.mockReset().mockResolvedValue({ error: null });
  h.update.mockReset().mockReturnValue({ eq: h.eq });
  window.history.replaceState(null, '', '/');
});

describe('LanguagePersistenceSync', () => {
  it('does nothing when signed out', () => {
    render(<LanguagePersistenceSync />);
    expect(h.a11y.setLanguage).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('applies the saved account language on sign-in without writing back', () => {
    signIn('fa');
    render(<LanguagePersistenceSync />);
    expect(h.a11y.setLanguage).toHaveBeenCalledWith('fa');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('seeds the account with the current language when nothing is saved', async () => {
    signIn(null);
    h.a11y.language = 'de';
    render(<LanguagePersistenceSync />);
    await waitFor(() => expect(h.update).toHaveBeenCalledWith({ preferred_language: 'de' }));
    expect(h.eq).toHaveBeenCalledWith('id', 'u1');
    expect(h.a11y.setLanguage).not.toHaveBeenCalled();
  });

  it('respects an explicit ?lang= link and does not overwrite the account', () => {
    window.history.replaceState(null, '', '/?lang=ar');
    signIn('fa');
    h.a11y.language = 'ar';
    render(<LanguagePersistenceSync />);
    expect(h.a11y.setLanguage).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('writes back a later language change', async () => {
    signIn('fa');
    h.a11y.language = 'fa';
    const { rerender } = render(<LanguagePersistenceSync />);
    expect(h.update).not.toHaveBeenCalled();

    h.a11y.language = 'es';
    rerender(<LanguagePersistenceSync />);
    await waitFor(() => expect(h.update).toHaveBeenCalledWith({ preferred_language: 'es' }));
  });

  it('ignores an invalid saved value instead of applying it', async () => {
    signIn('klingon');
    h.a11y.language = 'en';
    render(<LanguagePersistenceSync />);
    expect(h.a11y.setLanguage).not.toHaveBeenCalled();
    await waitFor(() => expect(h.update).toHaveBeenCalledWith({ preferred_language: 'en' }));
  });
});
