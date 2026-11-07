// Single-use CAPTCHA token store shared by <TurnstileWidget/> and every Supabase Auth call.
// Supabase verifies options.captchaToken server-side when CAPTCHA protection is enabled, and each token works once,
// so callers take it (which clears it) and the widget is asked to issue a fresh challenge afterwards.

let current: string | null = null;
const resetListeners = new Set<() => void>();

export function setCaptchaToken(token: string | null): void {
  current = token;
}

/** Spread into the `options` of an auth call: `{ ...takeCaptchaOptions() }`. Empty when no token is available. */
export function takeCaptchaOptions(): { captchaToken?: string } {
  const token = current;
  current = null;
  if (token) resetListeners.forEach((fn) => fn());
  return token ? { captchaToken: token } : {};
}

export function onCaptchaReset(fn: () => void): () => void {
  resetListeners.add(fn);
  return () => { resetListeners.delete(fn); };
}
