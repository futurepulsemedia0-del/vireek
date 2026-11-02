import { useCallback, useState } from 'react';
import { readNavSections, sectionOpen, writeNavSections, type NavSectionId, type NavSections } from '@/lib/navSections';

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function useNavSections(userId: string | null | undefined) {
  const [stored, setStored] = useState<NavSections>(() => readNavSections(userId, storage()));
  const isOpen = useCallback((id: NavSectionId, fallback: boolean) => sectionOpen(stored, id, fallback), [stored]);
  const toggle = useCallback(
    (id: NavSectionId, fallback: boolean) => {
      setStored((prev) => {
        const next = { ...prev, [id]: !sectionOpen(prev, id, fallback) };
        writeNavSections(userId, next, storage());
        return next;
      });
    },
    [userId],
  );
  return { isOpen, toggle };
}
