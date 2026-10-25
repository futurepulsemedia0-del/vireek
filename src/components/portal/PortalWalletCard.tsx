/**
 * Customer portal — "Add to your phone's wallet". Lists what this customer can add (upcoming visits, equipment
 * coverage, membership) and creates the pass on demand. Renders nothing when there is nothing to add.
 */

import { useEffect, useState } from 'react';
import { Loader2, Smartphone } from 'lucide-react';
import { fetchPortalWalletOptions, issuePortalWalletPass, type PortalWalletOption } from '@/lib/walletPassesApi';
import { WALLET_KIND_META, defaultTimezone } from '@/lib/walletPasses';

export function PortalWalletCard({ portalToken }: { portalToken: string }) {
  const [options, setOptions] = useState<PortalWalletOption[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchPortalWalletOptions(portalToken).then((o) => live && setOptions(o)).catch(() => live && setOptions([]));
    return () => { live = false; };
  }, [portalToken]);

  if (options.length === 0) return null;

  const add = async (opt: PortalWalletOption) => {
    setBusy(opt.subject_id);
    setError(null);
    try {
      window.location.assign(await issuePortalWalletPass(portalToken, opt, defaultTimezone()));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create your pass.');
      setBusy(null);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-4" aria-labelledby="portal-wallet-title">
      <div className="flex items-center gap-2">
        <Smartphone className="h-4 w-4 text-accent" aria-hidden />
        <h2 id="portal-wallet-title" className="text-sm font-semibold text-text-primary">Add to your phone&apos;s wallet</h2>
      </div>
      <p className="mt-1 text-xs text-text-secondary">Keep your technician&apos;s live arrival time, your coverage and membership one tap away.</p>
      <ul className="mt-3 space-y-2">
        {options.map((o) => (
          <li key={`${o.kind}:${o.subject_id}`} className="flex items-center justify-between gap-3 rounded-xl border border-border/60 p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text-primary">{o.label}</p>
              <p className="text-xs text-text-secondary">{WALLET_KIND_META[o.kind].noun}</p>
            </div>
            <button
              type="button"
              onClick={() => void add(o)}
              disabled={busy !== null}
              className="focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-60"
            >
              {busy === o.subject_id && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />} Add to Wallet
            </button>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
