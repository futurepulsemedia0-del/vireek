/** Where "Continue" sends the user once they're back online. */
export const OFFLINE_DEFAULT_RETURN = '/dashboard';

/**
 * Validates the `?from=` return path. Only same-origin, in-app paths are
 * accepted — anything else (absolute URLs, protocol-relative `//evil.com`,
 * `javascript:`, backslash tricks, the offline page itself) falls back to the
 * default, so the page can't be used as an open redirect.
 */
export function safeReturnPath(
  raw: string | null | undefined,
  fallback: string = OFFLINE_DEFAULT_RETURN,
): string {
  if (!raw) return fallback;
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  if (value.length > 2048) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return fallback; // control characters
  }
  const path = value.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (path === '/offline' || path === '/offline.html') return fallback;
  return value;
}

/** "just now" / "5 min ago" / "3 h ago" / "2 d ago" for the last successful sync. */
export function describeLastSync(
  timestamp: number | null | undefined,
  now: number = Date.now(),
): string {
  if (!timestamp || !Number.isFinite(timestamp)) return 'Not synced yet on this device';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return 'Last synced just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Last synced ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last synced ${hours} h ago`;
  return `Last synced ${Math.round(hours / 24)} d ago`;
}
