import { useCallback, useState } from 'react';

export interface RecentOption {
  value: string;
  label: string;
  description?: string;
}

const PREFIX = 'vireek:recent:';

function read(key: string): RecentOption[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREFIX + key) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((o): o is RecentOption => !!o && typeof o.value === 'string' && typeof o.label === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Most-recent-first picks for a combobox. `key` should include the user id (e.g. `${userId}:customers`). */
export function useRecentSelections(key: string | undefined, max = 5) {
  const [recents, setRecents] = useState<RecentOption[]>(() => (key ? read(key) : []));
  const push = useCallback(
    (option: RecentOption) => {
      if (!key) return;
      const next = [option, ...read(key).filter((o) => o.value !== option.value)].slice(0, max);
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(next));
      } catch {
        /* storage full or blocked: recents are a convenience only */
      }
      setRecents(next);
    },
    [key, max],
  );
  return { recents, push };
}
