import { supabase } from '@/lib/supabase';
import { hasAnyAnswer, sanitizeAnswers, type QualAnswers } from '@/lib/signupQualificationCore';

const DISMISS_KEY = 'vireek-qualification-dismissed';

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export function markQualificationDismissed(userId: string): void {
  try { sessionStorage.setItem(DISMISS_KEY, userId); } catch { /* storage unavailable */ }
}

export function isQualificationDismissed(userId: string): boolean {
  try { return sessionStorage.getItem(DISMISS_KEY) === userId; } catch { return false; }
}

export type QualificationStatus = 'done' | 'pending' | 'unknown';

/** 'unknown' on any error/timeout so callers fail open. */
export async function fetchQualificationStatus(userId: string): Promise<QualificationStatus> {
  try {
    const { data, error } = await withTimeout(
      supabase.from('signup_qualification').select('status').eq('user_id', userId).maybeSingle(),
      5000,
    );
    if (error) return 'unknown';
    return data ? 'done' : 'pending';
  } catch {
    return 'unknown';
  }
}

/** Returns true when the server confirmed the save. */
export async function saveQualification(answers: QualAnswers, skipped: boolean): Promise<boolean> {
  const clean = sanitizeAnswers(answers);
  try {
    const { error } = await withTimeout(
      supabase.rpc('save_signup_qualification', {
        p_trade: clean.trade ?? null,
        p_team_size: clean.team_size ?? null,
        p_call_handling: clean.call_handling ?? null,
        p_skipped: skipped || !hasAnyAnswer(clean),
      }),
      8000,
    );
    return !error;
  } catch {
    return false;
  }
}
