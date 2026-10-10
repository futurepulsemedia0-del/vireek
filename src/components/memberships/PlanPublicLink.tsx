import { useState } from 'react';
import { Check, Copy, Link2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';

interface PlanPublicLinkProps {
  plan: {
    id: string;
    active: boolean;
    price_cents: number;
    public_slug?: string | null;
    public_enabled?: boolean;
  };
}

// Stripe's minimum charge — keep in sync with MIN_PRICE_CENTS in membership-join-checkout.
const MIN_ONLINE_PRICE_CENTS = 50;

/**
 * Owner-side switch + shareable link for the public /join/:planSlug page.
 * Plans stay private until the owner turns this on.
 */
export function PlanPublicLink({ plan }: PlanPublicLinkProps) {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(Boolean(plan.public_enabled));
  const [slug, setSlug] = useState<string | null>(plan.public_slug ?? null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const tooCheap = plan.price_cents < MIN_ONLINE_PRICE_CENTS;
  const link = slug ? `${window.location.origin}/join/${slug}` : null;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    const { data, error } = await supabase
      .from('membership_plans')
      .update({ public_enabled: !enabled })
      .eq('id', plan.id)
      .select('public_slug, public_enabled')
      .single();
    setBusy(false);
    if (error || !data) {
      toast('Could not update the public link', 'error');
      return;
    }
    setEnabled(Boolean(data.public_enabled));
    setSlug(data.public_slug ?? null);
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Could not copy the link', 'error');
    }
  };

  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={busy || tooCheap}
          className="focus-ring inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
        >
          <Link2 size={13} aria-hidden /> {enabled ? 'Public signup link: On' : 'Public signup link: Off'}
        </button>
        {enabled && link && (
          <button
            type="button"
            onClick={() => void copy()}
            className="focus-ring inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-bg-tertiary"
          >
            {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />} {copied ? 'Copied' : 'Copy link'}
          </button>
        )}
      </div>
      {enabled && link && <p className="mt-1 break-all px-2 text-xs text-text-secondary">{link}</p>}
      {enabled && !plan.active && <p className="mt-1 px-2 text-xs text-warning-500">Activate this plan or the link will show as unavailable.</p>}
      {tooCheap && <p className="mt-1 px-2 text-xs text-text-secondary">Online signup needs a price of at least $0.50.</p>}
    </div>
  );
}
