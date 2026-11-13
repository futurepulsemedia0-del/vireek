// Recreated: verify against original intent
import { useEffect, useRef, useState } from 'react';
import { Tag } from 'lucide-react';
import { fetchAppliedPromos, PromoBackendMissingError, type AppliedPromo, type PromoDocKind } from '@/lib/promoCodes';

interface Props {
  kind: PromoDocKind;
  docId: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  /** Reports the server-computed pre-tax discount (cents) whenever it changes. */
  onChanged?: (discountCents: number) => void;
}

/**
 * Promo codes on a saved quote or invoice. The discount always comes from the server; this panel never computes one.
 * While the promo backend is not available it says so and reports a discount of 0 only for documents that have no
 * applied promos to show (it never hides a discount it could not read).
 * TODO(vireek): applying and removing codes needs the missing backend described in src/lib/promoCodes.ts.
 */
export function PromoCodePanel({ kind, docId, onChanged }: Props) {
  const [promos, setPromos] = useState<AppliedPromo[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  const seq = useRef(0);
  const cb = useRef(onChanged);
  cb.current = onChanged;

  const load = async () => {
    const mine = ++seq.current;
    setState('loading');
    try {
      const list = await fetchAppliedPromos(kind, docId);
      if (mine !== seq.current) return;
      setPromos(list);
      setState('ready');
      cb.current?.(list.reduce((s, p) => s + Math.max(0, p.discount_cents), 0));
    } catch (e) {
      if (mine !== seq.current) return;
      setState(e instanceof PromoBackendMissingError ? 'unavailable' : 'error');
    }
  };

  useEffect(() => {
    void load();
    return () => { seq.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, docId]);

  return (
    <section className="rounded-xl border border-border bg-bg-secondary p-3" aria-label="Promo codes">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Tag size={14} aria-hidden="true" /> Promo codes</h3>
      {state === 'loading' && <p role="status" className="mt-2 text-xs text-text-secondary">Checking…</p>}
      {state === 'unavailable' && <p role="status" className="mt-2 text-xs text-text-secondary">Promo codes are not available in this deployment, so no discount is applied here.</p>}
      {state === 'error' && <p role="alert" className="mt-2 text-xs text-danger">Could not load promo codes. <button type="button" onClick={() => void load()} className="focus-ring font-semibold underline">Try again</button></p>}
      {state === 'ready' && promos && (
        promos.length === 0 ? <p className="mt-2 text-xs text-text-secondary">No promo code applied.</p> : (
          <ul className="mt-2 divide-y divide-border text-sm">
            {promos.map((p) => <li key={p.id} className="flex justify-between gap-3 py-1.5"><span className="text-text-primary">{p.code} <span className="text-xs text-text-secondary">{p.label}</span></span><span className="text-success-500">−${(p.discount_cents / 100).toFixed(2)}</span></li>)}
          </ul>
        )
      )}
    </section>
  );
}
