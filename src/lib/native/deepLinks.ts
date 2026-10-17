// src/lib/native/deepLinks.ts — pure link resolution (unit tested). Accepts only vireek.com
// URLs, the vireek:// scheme and same-app relative paths, so a crafted link can never
// navigate the app somewhere else.

const APP_HOSTS = new Set(['vireek.com', 'www.vireek.com']);
const AUTH_PARAMS = /[#&?](access_token|token_hash|code|error_code)=/;

export interface ResolvedLink {
  /** Path + query + hash inside the SPA. */
  path: string;
  /** Supabase auth links (reset / magic link) must be parsed by a fresh page load. */
  isAuthLink: boolean;
}

export function resolveDeepLink(raw: string): ResolvedLink | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    if (!raw.startsWith('/') || raw.startsWith('//')) return null;
    try {
      url = new URL(raw, 'https://vireek.com');
    } catch {
      return null;
    }
  }

  let path: string;
  if (url.protocol === 'https:' && APP_HOSTS.has(url.hostname)) {
    path = url.pathname;
  } else if (url.protocol === 'vireek:') {
    path = '/' + [url.hostname, url.pathname.replace(/^\/+/, '')].filter(Boolean).join('/');
  } else {
    return null;
  }

  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null;
  const full = path + url.search + url.hash;
  return { path: full, isAuthLink: AUTH_PARAMS.test(url.search + url.hash) };
}
