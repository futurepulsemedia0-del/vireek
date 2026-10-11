import { useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { setTippingEnabled } from '@/lib/payments';

export function TippingToggle({ initial }: { initial: boolean }) {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !enabled;
    setBusy(true);
    try {
      await setTippingEnabled(next);
      setEnabled(next);
      toast(next ? 'Tipping turned on' : 'Tipping turned off', 'success');
    } catch {
      toast('Could not update tipping — try again', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-between rounded-xl border border-border-primary bg-bg-secondary p-4">
      <div>
        <p className="text-sm font-semibold text-text-primary">Customer tipping</p>
        <p className="text-xs text-text-secondary">Let customers tip the assigned technician when they pay. Tips are paid out through payroll.</p>
      </div>
      <button type="button" role="switch" aria-checked={enabled} disabled={busy} onClick={toggle}
        className={`focus-ring relative h-6 w-11 rounded-full transition disabled:opacity-50 ${enabled ? 'bg-accent' : 'bg-bg-tertiary'}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
    </div>
  );
}
