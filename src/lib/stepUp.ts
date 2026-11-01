import { supabase } from '@/lib/supabase';
import { availableMethods, type StepUpMethod } from '@/lib/stepUpCore';

export interface StepUpOptions {
  methods: StepUpMethod[];
  email: string | null;
}

/** Real proof-of-presence options for the signed-in user. */
export async function loadStepUpOptions(): Promise<StepUpOptions> {
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  const email = user?.email ?? null;
  const rawProviders = user?.app_metadata?.providers;
  const providers = Array.isArray(rawProviders) ? rawProviders.filter((p): p is string => typeof p === 'string') : [];
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const hasVerifiedTotp = (factors?.totp ?? []).some((f) => f.status === 'verified');
  return { methods: availableMethods({ providers, hasVerifiedTotp, email }), email };
}

// Each of these ends in a fresh `amr` timestamp on the session, which is what the database checks.
export async function verifyWithPassword(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function sendEmailCode(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (error) throw error;
}

export async function verifyEmailCode(email: string, token: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({ email, token: token.trim(), type: 'email' });
  if (error) throw error;
}

export async function verifyWithTotp(code: string): Promise<void> {
  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
  if (listError) throw listError;
  const factor = (factors?.totp ?? []).find((f) => f.status === 'verified');
  if (!factor) throw new Error('NO_TOTP_FACTOR');
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
  if (error) throw error;
}
