import { supabase } from '@/lib/supabase';

/**
 * Phone (SMS code) sign-in for the business login page.
 *
 * - Never creates users: `shouldCreateUser: false`. Phone-only accounts are
 *   homeowners and are created on /home/sign-in (see handle_new_user()).
 * - After a verified code, `destination` says where the person belongs:
 *   accounts with a `profiles` row are business accounts; the rest are homeowners.
 */

export type PhoneDestination = 'business' | 'home';

export type PhoneCodeResult =
  | { ok: true }
  | { ok: false; reason: 'no_account' | 'rate_limited' | 'failed'; message: string };

export type PhoneVerifyResult =
  | { ok: true; destination: PhoneDestination }
  | { ok: false; message: string };

const NO_ACCOUNT = /signups? not allowed|otp_disabled|user not found/i;
const RATE_LIMITED = /rate limit|too many|only request this after|\d+ seconds/i;

export async function requestPhoneSignInCode(phoneE164: string): Promise<PhoneCodeResult> {
  try {
    const { error } = await supabase.auth.signInWithOtp({
      phone: phoneE164,
      options: { shouldCreateUser: false },
    });
    if (!error) return { ok: true };

    const { code, status } = error as { code?: string; status?: number };
    const text = `${code ?? ''} ${error.message}`;
    if (status === 429 || RATE_LIMITED.test(text)) {
      return { ok: false, reason: 'rate_limited', message: 'Please wait a moment before requesting another code.' };
    }
    if (NO_ACCOUNT.test(text)) {
      return { ok: false, reason: 'no_account', message: "We couldn't find an account for that number." };
    }
    return { ok: false, reason: 'failed', message: "We couldn't send a code to that number. Check it and try again." };
  } catch {
    return { ok: false, reason: 'failed', message: "We couldn't reach Vireek. Check your connection and try again." };
  }
}

async function resolveDestination(userId: string): Promise<PhoneDestination> {
  try {
    const { data, error } = await supabase.from('profiles').select('id').eq('id', userId).maybeSingle();
    // Only a clean "no profile" answer means homeowner. On any error keep the
    // default business path (same as every other sign-in method).
    return !error && !data ? 'home' : 'business';
  } catch {
    return 'business';
  }
}

export async function verifyPhoneSignInCode(phoneE164: string, code: string): Promise<PhoneVerifyResult> {
  try {
    const { data, error } = await supabase.auth.verifyOtp({ phone: phoneE164, token: code, type: 'sms' });
    if (error) {
      return { ok: false, message: 'That code is incorrect or has expired. Send a new one below.' };
    }
    const userId = data.user?.id ?? data.session?.user.id;
    return { ok: true, destination: userId ? await resolveDestination(userId) : 'business' };
  } catch {
    return { ok: false, message: 'Something went wrong verifying that code. Try again.' };
  }
}
