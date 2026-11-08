import { useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { hasConsent, onCategoryChange } from '@/lib/consent/engine';
import { captureLanding, clearAttribution, flushAttribution } from '@/lib/growth/growthAttribution';
import { recordSignupAttribution } from '@/lib/growth/growthApi';

/**
 * Records first-touch acquisition attribution, strictly after analytics consent.
 *  1. On landing (and whenever consent is granted) store UTM/referrer-host locally.
 *  2. Once the account OWNER is signed in, send it once to record_signup_attribution (server re-validates) and clear it.
 *  3. Withdrawing analytics consent deletes the stored value.
 */
export function GrowthAttributionSync() {
  const { profile, isOwner } = useAuth();
  const ownerId = isOwner ? profile?.id : undefined;

  useEffect(() => {
    let storage: Storage;
    try {
      storage = window.localStorage;
    } catch {
      return;
    }
    const capture = () =>
      captureLanding({ storage, hasConsent: () => hasConsent('analytics'), now: Date.now, search: window.location.search, referrer: document.referrer, ownHost: window.location.hostname });
    return onCategoryChange('analytics', (granted) => {
      if (granted) capture();
      else clearAttribution(storage);
    });
  }, []);

  useEffect(() => {
    if (!ownerId) return;
    let storage: Storage;
    try {
      storage = window.localStorage;
    } catch {
      return;
    }
    void flushAttribution({ storage, hasConsent: () => hasConsent('analytics'), now: Date.now }, recordSignupAttribution).catch(() => {
      /* kept in storage; retried on the next load */
    });
  }, [ownerId]);

  return null;
}
