import { useEffect, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useAccessibility } from '@/contexts/AccessibilityContext';
import { supabase } from '@/lib/supabase';
import { normalizeLanguage, readUrlLanguage } from '@/lib/languageSync';
import type { LanguageCode } from '@/lib/i18n';

/**
 * Persists the UI language per user (profiles.preferred_language).
 *
 * - On sign-in: the account's saved language wins over localStorage/browser,
 *   unless the visitor arrived through an explicit ?lang= link.
 * - First sign-in with nothing saved: seeds the account with the current language.
 * - Afterwards: every language change is written back (best-effort).
 *
 * Must render inside BOTH AuthProvider and AccessibilityProvider.
 */
export function LanguagePersistenceSync() {
  const { user, profile } = useAuth();
  const { language, setLanguage } = useAccessibility();

  const reconciledFor = useRef<string | null>(null);
  const lastSynced = useRef<LanguageCode | null>(null);

  const userId = user?.id ?? null;
  const profileId = profile?.id ?? null;
  const remoteRaw = profile?.preferred_language ?? null;

  useEffect(() => {
    if (!userId) {
      reconciledFor.current = null;
      lastSynced.current = null;
      return;
    }
    if (profileId !== userId) return; // profile not loaded yet

    if (reconciledFor.current !== userId) {
      reconciledFor.current = userId;
      const remote = normalizeLanguage(remoteRaw);
      const explicitUrlLanguage = readUrlLanguage();

      if (explicitUrlLanguage) {
        lastSynced.current = language; // shared link: don't overwrite the account
      } else if (remote) {
        lastSynced.current = remote;
        if (remote !== language) {
          setLanguage(remote);
          return; // next render has language === remote, nothing to push
        }
      }
      // remote === null and no URL language: lastSynced stays null -> seed below
    }

    if (language === lastSynced.current) return;

    const code = language;
    lastSynced.current = code; // optimistic: prevents duplicate writes on re-render
    void (async () => {
      try {
        const { error } = await supabase
          .from('profiles')
          .update({ preferred_language: code })
          .eq('id', userId);
        if (error && lastSynced.current === code) lastSynced.current = null; // retry on next change
      } catch {
        if (lastSynced.current === code) lastSynced.current = null;
      }
    })();
  }, [userId, profileId, remoteRaw, language, setLanguage]);

  return null;
}
