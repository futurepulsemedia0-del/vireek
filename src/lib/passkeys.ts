import { supabase } from '@/lib/supabase';
import { describeUserAgent } from '@/lib/sessions';

/**
 * Passkey (WebAuthn) helpers on top of Supabase Auth's native passkey API
 * (`supabase.auth.registerPasskey / signInWithPasskey / passkey.*`).
 *
 * The API is flagged experimental by Supabase, so every call site goes
 * through this one file: if the SDK surface changes, only this file moves.
 * The client must be created with `auth: { experimental: { passkey: true } }`
 * (see src/lib/supabase.ts) and the project needs Authentication → Passkeys
 * enabled with the right relying-party settings (docs/AUTH_PASSKEYS_SOCIAL_LOGIN_ALERTS.md).
 */

export interface PasskeyRow {
  id: string;
  friendly_name: string | null;
  created_at: string;
  last_used_at: string | null;
}

export type PasskeyFailureKind =
  | 'cancelled'
  | 'unsupported'
  | 'disabled'
  | 'limit'
  | 'duplicate'
  | 'unconfirmed'
  | 'not_found'
  | 'expired'
  | 'banned'
  | 'unknown';

export interface PasskeyFailure {
  kind: PasskeyFailureKind;
  message: string;
}

/** Minimal shape of the (experimental) SDK surface we rely on. */
interface PasskeyAuthApi {
  registerPasskey(): Promise<{ data: unknown; error: unknown }>;
  signInWithPasskey(args?: {
    options?: { mediation?: 'conditional' | 'optional' | 'required' | 'silent'; signal?: AbortSignal };
  }): Promise<{ data: { session?: unknown; user?: unknown } | null; error: unknown }>;
  passkey: {
    list(): Promise<unknown>;
    update(args: { passkeyId: string; friendlyName: string }): Promise<unknown>;
    delete(args: { passkeyId: string }): Promise<unknown>;
  };
}

function api(): PasskeyAuthApi {
  return supabase.auth as unknown as PasskeyAuthApi;
}

/** Thrown for any failed passkey operation; carries a user-presentable classification. */
export class PasskeyError extends Error {
  readonly kind: PasskeyFailureKind;
  constructor(failure: PasskeyFailure) {
    super(failure.message);
    this.name = 'PasskeyError';
    this.kind = failure.kind;
  }
}

export function isPasskeySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function'
  );
}

/** Can the browser show passkeys in the email field's autofill dropdown? */
export async function isConditionalUiAvailable(): Promise<boolean> {
  try {
    if (!isPasskeySupported()) return false;
    const pkc = window.PublicKeyCredential as unknown as { isConditionalMediationAvailable?: () => Promise<boolean> };
    return typeof pkc.isConditionalMediationAvailable === 'function' ? Boolean(await pkc.isConditionalMediationAvailable()) : false;
  } catch {
    return false;
  }
}

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  error_code?: unknown;
  message?: unknown;
  cause?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Turns anything the SDK / browser can throw or return into a stable classification. */
export function classifyPasskeyError(err: unknown): PasskeyFailure {
  const e = (err && typeof err === 'object' ? err : {}) as ErrorLike;
  const cause = (e.cause && typeof e.cause === 'object' ? e.cause : {}) as ErrorLike;
  const code = (str(e.error_code) || str(e.code)).toLowerCase();
  const name = str(e.name);
  const causeName = str(cause.name);
  const message = str(e.message) || (typeof err === 'string' ? err : '');

  if (
    name === 'NotAllowedError' ||
    causeName === 'NotAllowedError' ||
    name === 'AbortError' ||
    causeName === 'AbortError' ||
    code.includes('abort') ||
    code.includes('cancel')
  ) {
    return { kind: 'cancelled', message: 'Passkey prompt was cancelled.' };
  }
  if (code === 'passkey_disabled') {
    return { kind: 'disabled', message: 'Passkeys are not enabled for this workspace yet.' };
  }
  if (code === 'too_many_passkeys') {
    return { kind: 'limit', message: 'You have reached the maximum number of passkeys. Remove one to add another.' };
  }
  if (code === 'webauthn_credential_exists' || name === 'InvalidStateError' || causeName === 'InvalidStateError') {
    return { kind: 'duplicate', message: 'This device or security key is already registered as a passkey.' };
  }
  if (code === 'email_not_confirmed' || code === 'phone_not_confirmed') {
    return { kind: 'unconfirmed', message: 'Confirm your email address before using a passkey.' };
  }
  if (code === 'user_banned') {
    return { kind: 'banned', message: 'This account cannot sign in right now.' };
  }
  if (code === 'webauthn_credential_not_found') {
    return { kind: 'not_found', message: 'That passkey is no longer registered. Sign in another way and add a new one.' };
  }
  if (code === 'webauthn_challenge_expired' || code === 'webauthn_challenge_not_found') {
    return { kind: 'expired', message: 'The passkey request expired. Please try again.' };
  }
  if (name === 'NotSupportedError' || /not.?supported/.test(code) || /not supported/i.test(message)) {
    return { kind: 'unsupported', message: "This browser or device doesn't support passkeys." };
  }
  if (code === 'webauthn_verification_failed') {
    return { kind: 'unknown', message: "We couldn't verify that passkey. Please try again or use another sign-in method." };
  }
  return { kind: 'unknown', message: message || 'Something went wrong with your passkey. Please try again.' };
}

function fail(err: unknown): never {
  throw new PasskeyError(classifyPasskeyError(err));
}

/** Unwraps both `{ data, error }` envelopes and bare payloads. */
function unwrap<T>(res: unknown): T {
  if (res && typeof res === 'object' && !Array.isArray(res) && ('error' in res || 'data' in res)) {
    const env = res as { data?: T; error?: unknown };
    if (env.error) fail(env.error);
    return env.data as T;
  }
  return res as T;
}

/** Friendly default like "Chrome on Mac" — shown in the list so users can tell passkeys apart. */
export function suggestPasskeyName(userAgent: string | null | undefined = typeof navigator !== 'undefined' ? navigator.userAgent : null): string {
  const label = describeUserAgent(userAgent ?? null);
  return label === 'Unknown device' ? 'My passkey' : label;
}

export function normalizeFriendlyName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Runs the browser ceremony and registers a passkey for the signed-in user. */
export async function registerNewPasskey(friendlyName?: string): Promise<PasskeyRow> {
  if (!isPasskeySupported()) fail({ name: 'NotSupportedError' });
  let created: { id: string; friendly_name?: string | null; created_at: string };
  try {
    created = unwrap(await api().registerPasskey());
  } catch (err) {
    if (err instanceof PasskeyError) throw err;
    fail(err);
  }
  const wanted = normalizeFriendlyName(friendlyName ?? suggestPasskeyName());
  let finalName: string | null = created.friendly_name ?? null;
  if (wanted && wanted !== finalName) {
    try {
      unwrap(await api().passkey.update({ passkeyId: created.id, friendlyName: wanted }));
      finalName = wanted;
    } catch {
      /* The passkey itself is registered; a failed rename is cosmetic. */
    }
  }
  return { id: created.id, friendly_name: finalName, created_at: created.created_at, last_used_at: null };
}

export interface PasskeySignInOptions {
  /** 'conditional' = passkey autofill on the email field (never opens a modal). */
  mediation?: 'conditional';
  signal?: AbortSignal;
}

/** Signs in with a discoverable passkey. Resolves with the session on success; throws PasskeyError. */
export async function signInWithPasskey(opts: PasskeySignInOptions = {}): Promise<void> {
  if (!isPasskeySupported()) fail({ name: 'NotSupportedError' });
  try {
    const options = opts.mediation || opts.signal ? { options: { mediation: opts.mediation, signal: opts.signal } } : undefined;
    const { data, error } = await api().signInWithPasskey(options);
    if (error) fail(error);
    if (!data?.session) fail({ message: 'Passkey sign-in did not return a session.' });
  } catch (err) {
    if (err instanceof PasskeyError) throw err;
    fail(err);
  }
}

export async function listPasskeys(): Promise<PasskeyRow[]> {
  const raw = unwrap<Array<Partial<PasskeyRow> & { id: string; created_at: string }> | null>(await api().passkey.list());
  return (raw ?? [])
    .map((p) => ({
      id: p.id,
      friendly_name: p.friendly_name ?? null,
      created_at: p.created_at,
      last_used_at: p.last_used_at ?? null,
    }))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export async function renamePasskey(passkeyId: string, friendlyName: string): Promise<void> {
  const name = normalizeFriendlyName(friendlyName);
  if (!name) fail({ message: 'Give your passkey a name.' });
  unwrap(await api().passkey.update({ passkeyId, friendlyName: name }));
}

export async function deletePasskey(passkeyId: string): Promise<void> {
  unwrap(await api().passkey.delete({ passkeyId }));
}
