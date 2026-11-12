// src/hooks/useAccountResourceCounts.ts
//
// Read-only counts for the Usage dashboard: team seats and phone numbers in use.
// Two cheap HEAD count queries; RLS scopes both to the signed-in account. Each metric fails independently
// (null = unknown), so one failing table never hides the other.
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export interface AccountResourceCounts {
  status: 'idle' | 'loading' | 'ready';
  /** Owner (1) + team members. Null when it could not be loaded. */
  seatsUsed: number | null;
  /** Phone numbers that are not released. Null when it could not be loaded. */
  numbersActive: number | null;
}

const IDLE: AccountResourceCounts = { status: 'idle', seatsUsed: null, numbersActive: null };

export function useAccountResourceCounts(ownerId: string | null): AccountResourceCounts {
  const [state, setState] = useState<AccountResourceCounts>(IDLE);

  useEffect(() => {
    if (!ownerId) {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, status: 'loading' }));

    void (async () => {
      const [members, numbers] = await Promise.all([
        supabase.from('team_members').select('id', { count: 'exact', head: true }).eq('account_owner_id', ownerId),
        supabase.from('phone_numbers').select('id', { count: 'exact', head: true }).eq('account_id', ownerId).neq('status', 'released'),
      ]).catch(() => [null, null] as const);
      if (cancelled) return;
      setState({
        status: 'ready',
        seatsUsed: members && !members.error && typeof members.count === 'number' ? members.count + 1 : null,
        numbersActive: numbers && !numbers.error && typeof numbers.count === 'number' ? numbers.count : null,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [ownerId]);

  return state;
}
