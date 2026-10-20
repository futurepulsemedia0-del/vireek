import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

/** Business side: lets the account share one customer-attached document with that customer's Vireek Home app. */
export function HomeownerShareToggle({ documentId, canManage }: { documentId: string; canManage: boolean }) {
  const [state, setState] = useState<{ hasCustomer: boolean; visible: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    void (async () => {
      const { data } = await supabase
        .from('documents')
        .select('customer_id, homeowner_visible')
        .eq('id', documentId)
        .maybeSingle();
      if (!cancelled) setState({ hasCustomer: Boolean(data?.customer_id), visible: Boolean(data?.homeowner_visible) });
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  if (!state?.hasCustomer) return null;

  const toggle = async () => {
    setBusy(true);
    setError(null);
    const next = !state.visible;
    const { error: rpcError } = await supabase.rpc('set_document_homeowner_visible', {
      p_document_id: documentId,
      p_visible: next,
    });
    if (rpcError) setError('Could not update sharing.');
    else setState({ ...state, visible: next });
    setBusy(false);
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3">
      <div>
        <p className="text-xs font-medium text-text-primary">Share with the customer in Vireek Home</p>
        <p className="text-[11px] text-text-secondary">
          Visible only if the customer has connected and chosen to see documents.
        </p>
        {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={state.visible}
        aria-label="Share with the customer in Vireek Home"
        disabled={!canManage || busy}
        onClick={() => void toggle()}
        className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${state.visible ? 'bg-accent' : 'bg-bg-tertiary'}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${state.visible ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
    </div>
  );
}
