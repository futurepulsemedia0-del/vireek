// src/components/integrations/ProviderDisconnectControl.tsx
//
// "Disconnect" button + confirmation for a connected third-party integration. Calls the `provider-disconnect` edge
// function (credentials deleted server-side, Google tokens revoked where supported). Uses the app's ConfirmDialog so
// destructive actions behave identically everywhere (focus trap, Escape, two-step confirm).

import { useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { disconnectProvider, followUpNote, type DisconnectableProvider } from '@/lib/providerDisconnect';

interface ProviderDisconnectControlProps {
  provider: DisconnectableProvider;
  providerLabel: string;
  /** Exact consequences shown in the dialog, e.g. ["Stop syncing prices from Jobber"]. */
  consequences: string[];
  onDisconnected: () => void;
}

export function ProviderDisconnectControl({ provider, providerLabel, consequences, onDisconnected }: ProviderDisconnectControlProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    const result = await disconnectProvider((name, options) => supabase.functions.invoke(name, options), provider);
    setBusy(false);
    setOpen(false);
    if (!result.ok) {
      toast(result.message, 'error');
      return;
    }
    toast(`${providerLabel} disconnected.`, 'success');
    const note = followUpNote(providerLabel, provider, result.revoked);
    if (note) toast(note, 'info');
    onDisconnected();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={busy}
        aria-label={`Disconnect ${providerLabel}`}
        className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
      >
        Disconnect
      </button>
      <ConfirmDialog
        open={open}
        title={`Disconnect ${providerLabel}?`}
        description="Vireek will stop using this connection right away. You can reconnect at any time."
        confirmLabel="Yes, disconnect"
        consequences={consequences}
        onConfirm={handleConfirm}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
