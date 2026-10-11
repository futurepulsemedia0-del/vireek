import { useEffect, useState } from 'react';
import { loadTaxClasses, onTaxClassesInvalidated, type TaxClassDetail } from '@/lib/salesTaxApi';

/** Account tax classes, loaded once and shared by every line-item select on the page. */
export function useTaxClasses() {
  const [classes, setClasses] = useState<TaxClassDetail[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = () => {
      loadTaxClasses()
        .then((c) => {
          if (!active) return;
          setClasses(c);
          setLoading(false);
        })
        .catch(() => {
          if (active) setLoading(false);
        });
    };
    load();
    const off = onTaxClassesInvalidated(load);
    return () => {
      active = false;
      off();
    };
  }, []);

  return { classes, loading };
}
