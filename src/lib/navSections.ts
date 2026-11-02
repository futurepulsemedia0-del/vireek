// Remembers which collapsible nav sections the user opened, per user, per device.
export type NavSectionId = 'account' | 'appearance';
export type NavSections = Partial<Record<NavSectionId, boolean>>;

const key = (userId: string) => `vrk:nav-sections:${userId}`;

export function readNavSections(userId: string | null | undefined, kv: Pick<Storage, 'getItem'> | null): NavSections {
  if (!userId || !kv) return {};
  try {
    const raw: unknown = JSON.parse(kv.getItem(key(userId)) ?? '{}');
    if (typeof raw !== 'object' || raw === null) return {};
    const r = raw as Record<string, unknown>;
    const out: NavSections = {};
    if (typeof r.account === 'boolean') out.account = r.account;
    if (typeof r.appearance === 'boolean') out.appearance = r.appearance;
    return out;
  } catch {
    return {};
  }
}

export function writeNavSections(userId: string | null | undefined, value: NavSections, kv: Pick<Storage, 'setItem'> | null): void {
  if (!userId || !kv) return;
  try {
    kv.setItem(key(userId), JSON.stringify(value));
  } catch {
    /* private mode / quota: not remembered */
  }
}

/** Stored choice wins; otherwise fall back to the route-derived default (e.g. open when a child is active). */
export const sectionOpen = (stored: NavSections, id: NavSectionId, fallback: boolean): boolean => stored[id] ?? fallback;
