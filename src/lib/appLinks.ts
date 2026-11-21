export type StoreId = 'ios' | 'android';

export interface StoreLink {
  id: StoreId;
  label: string;
  href: string;
}

/**
 * وقتی اپ منتشر شد، لینک رسمی را اینجا بگذار. تا زمانی که null است، دکمه آن استور نمایش داده نمی‌شود.
 * ios:     https://apps.apple.com/...
 * android: https://play.google.com/store/apps/details?id=...
 */
export const STORE_URLS: Readonly<Record<StoreId, string | null>> = {
  ios: null,
  android: null,
};

const ALLOWED_HOST: Readonly<Record<StoreId, string>> = {
  ios: 'apps.apple.com',
  android: 'play.google.com',
};

const LABEL: Readonly<Record<StoreId, string>> = {
  ios: 'App Store',
  android: 'Google Play',
};

/** فقط https و فقط دامنه رسمی همان استور قبول می‌شود. */
export function sanitizeStoreUrl(raw: string | null, id: StoreId): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== ALLOWED_HOST[id]) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function getStoreLinks(): StoreLink[] {
  const links: StoreLink[] = [];
  (['ios', 'android'] as const).forEach((id) => {
    const href = sanitizeStoreUrl(STORE_URLS[id], id);
    if (href) links.push({ id, label: LABEL[id], href });
  });
  return links;
}
