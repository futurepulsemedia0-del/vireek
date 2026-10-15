import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Copy, Download, LifeBuoy, RefreshCw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { generateRecoveryCodes, getRecoveryCodeCount, recoveryCodesFile } from '@/lib/mfaChallenge';

/**
 * Recovery-code management card for Security settings. Render it only while
 * 2FA is enabled. Codes are shown exactly once — the server keeps only hashes.
 */
export function RecoveryCodesPanel() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [remaining, setRemaining] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      setRemaining(await getRecoveryCodeCount());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load recovery codes.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const generate = async () => {
    setConfirmOpen(false);
    setGenerating(true);
    setActionError('');
    try {
      const fresh = await generateRecoveryCodes();
      setCodes(fresh);
      setSaved(false);
      setRemaining(fresh.length);
    } catch (err) {
      const code = (err as { code?: string }).code;
      setActionError(
        code === 'AAL2_REQUIRED'
          ? 'For your security, sign out and sign back in with your authenticator code, then generate codes.'
          : err instanceof Error
            ? err.message
            : 'Could not generate recovery codes.',
      );
    } finally {
      setGenerating(false);
    }
  };

  const copy = async () => {
    if (!codes) return;
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast('Recovery codes copied.', 'success');
    } catch {
      toast("Couldn't copy automatically — select the codes and copy them manually.", 'error');
    }
  };

  const download = () => {
    if (!codes) return;
    const blob = new Blob([recoveryCodesFile(codes, user?.email)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vireek-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="mt-4 !p-6 hover:!translate-y-0">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
          <LifeBuoy size={18} />
        </span>
        <div>
          <h2 className="text-base font-semibold text-text-primary">Recovery codes</h2>
          <p className="text-xs text-text-secondary">One-time codes for when you can't use your authenticator app.</p>
        </div>
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="h-9 w-48 animate-pulse rounded-xl bg-bg-tertiary" aria-busy="true" />
        ) : loadError ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3" role="alert">
            <p className="flex-1 text-sm text-text-primary">{loadError}</p>
            <button type="button" onClick={load} className="focus-ring rounded-lg px-2.5 py-1.5 text-xs font-semibold text-accent hover:bg-accent/10">
              Try again
            </button>
          </div>
        ) : codes ? (
          <div>
            <p className="flex items-start gap-2 rounded-xl bg-warning-500/10 p-3 text-sm text-text-primary" role="status">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning-500" />
              Save these codes now — we can't show them again. Each one works once.
            </p>
            <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Recovery codes">
              {codes.map((c) => (
                <li key={c} className="rounded-lg bg-bg-tertiary px-3 py-2 text-center font-mono text-sm tracking-widest text-text-primary">
                  {c}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={copy} className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border px-3.5 py-2 text-sm font-medium text-text-primary hover:bg-bg-tertiary">
                <Copy size={15} /> Copy
              </button>
              <button type="button" onClick={download} className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border px-3.5 py-2 text-sm font-medium text-text-primary hover:bg-bg-tertiary">
                <Download size={15} /> Download
              </button>
            </div>
            <label className="mt-4 flex items-center gap-2.5 text-sm text-text-primary">
              <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent-primary))]" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              I've saved these codes somewhere safe
            </label>
            <Button size="sm" className="mt-3" disabled={!saved} onClick={() => setCodes(null)}>
              Done
            </Button>
          </div>
        ) : (
          <div>
            <p className="text-sm text-text-secondary">
              {remaining === 0
                ? "You don't have any recovery codes. Generate a set so you can still sign in if you lose your phone."
                : `You have ${remaining} unused recovery code${remaining === 1 ? '' : 's'}.`}
            </p>
            {actionError && (
              <p className="mt-3 flex items-start gap-2 rounded-xl bg-danger/5 p-3 text-sm text-text-primary" role="alert">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" /> {actionError}
              </p>
            )}
            <Button size="sm" className="mt-3" onClick={() => (remaining ? setConfirmOpen(true) : generate())} disabled={generating}>
              <RefreshCw size={15} className={generating ? 'animate-spin' : ''} />
              {generating ? 'Generating…' : remaining ? 'Generate new codes' : 'Generate recovery codes'}
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Replace your recovery codes?"
        description="Your current codes will stop working immediately. Make sure you save the new ones."
        confirmLabel="Replace codes"
        onConfirm={generate}
        onCancel={() => setConfirmOpen(false)}
      />
    </Card>
  );
}
