import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Fingerprint, Pencil, Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import {
  PasskeyError,
  PasskeyRow,
  deletePasskey,
  isPasskeySupported,
  listPasskeys,
  registerNewPasskey,
  renamePasskey,
} from '@/lib/passkeys';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * "Manage passkeys" section for Security Settings: lists the signed-in
 * user's passkeys (Supabase Auth), adds new ones, renames and removes them.
 * Self-contained — owns its own loading, errors and confirm dialog.
 */
export function PasskeysCard() {
  const { toast } = useToast();
  const supported = isPasskeySupported();

  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PasskeyRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setPasskeys(await listPasskeys());
    } catch (err) {
      setLoadError(err instanceof PasskeyError ? err.message : "Couldn't load your passkeys.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async () => {
    setAdding(true);
    try {
      await registerNewPasskey();
      toast('Passkey added. You can now sign in with it.', 'success');
      await load();
    } catch (err) {
      if (err instanceof PasskeyError) {
        if (err.kind !== 'cancelled') toast(err.message, 'error');
      } else {
        toast("Couldn't add a passkey. Please try again.", 'error');
      }
    } finally {
      setAdding(false);
    }
  };

  const startRename = (p: PasskeyRow) => {
    setEditingId(p.id);
    setEditName(p.friendly_name ?? '');
  };

  const submitRename = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingId) return;
    setSavingId(editingId);
    try {
      await renamePasskey(editingId, editName);
      setEditingId(null);
      await load();
    } catch (err) {
      toast(err instanceof PasskeyError ? err.message : "Couldn't rename that passkey.", 'error');
    } finally {
      setSavingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deletePasskey(deleteTarget.id);
      toast('Passkey removed.', 'info');
      await load();
    } catch (err) {
      toast(err instanceof PasskeyError ? err.message : "Couldn't remove that passkey.", 'error');
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark" data-testid="passkeys-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
            <Fingerprint size={18} />
          </span>
          <div>
            <h2 className="text-base font-semibold text-text-primary">Passkeys</h2>
            <p className="text-xs text-text-secondary">
              Sign in with your fingerprint, face or device PIN — no password to steal or phish.
            </p>
          </div>
        </div>
        {supported && (
          <button
            type="button"
            onClick={handleAdd}
            disabled={adding}
            className="focus-ring inline-flex shrink-0 items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Plus size={16} aria-hidden="true" />
            {adding ? 'Waiting…' : 'Add a passkey'}
          </button>
        )}
      </div>

      {!supported && (
        <p className="mt-4 text-sm text-text-secondary" role="status">
          This browser or device doesn&rsquo;t support passkeys. Open Vireek in an up-to-date Chrome, Safari, Edge or Firefox to add one.
        </p>
      )}

      <div className="mt-4 space-y-2" aria-live="polite">
        {loading ? (
          <div className="space-y-2">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="h-14 w-full animate-pulse rounded-xl bg-bg-tertiary" />
            ))}
          </div>
        ) : loadError ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3">
            <p className="text-sm text-text-secondary">{loadError}</p>
            <button type="button" onClick={load} className="focus-ring text-sm font-semibold text-accent hover:underline">
              Retry
            </button>
          </div>
        ) : passkeys.length === 0 ? (
          <p className="text-sm text-text-secondary">
            No passkeys yet. Add one to sign in faster and protect your account from phishing.
          </p>
        ) : (
          passkeys.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3">
              {editingId === p.id ? (
                <form onSubmit={submitRename} className="flex flex-1 items-center gap-2">
                  <label htmlFor={`passkey-name-${p.id}`} className="sr-only">
                    Passkey name
                  </label>
                  <input
                    id={`passkey-name-${p.id}`}
                    autoFocus
                    value={editName}
                    maxLength={120}
                    onChange={(e) => setEditName(e.target.value)}
                    className="focus-ring h-9 min-w-0 flex-1 rounded-lg border border-border bg-bg-secondary px-3 text-sm text-text-primary"
                  />
                  <button
                    type="submit"
                    disabled={savingId === p.id || !editName.trim()}
                    className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="focus-ring rounded-lg px-3 py-1.5 text-sm font-medium text-text-secondary hover:text-text-primary"
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-primary">{p.friendly_name || 'Unnamed passkey'}</p>
                    <p className="text-xs text-text-secondary">
                      Added {formatDate(p.created_at)} · Last used {formatDate(p.last_used_at)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => startRename(p)}
                      aria-label={`Rename passkey ${p.friendly_name ?? ''}`.trim()}
                      className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(p)}
                      aria-label={`Remove passkey ${p.friendly_name ?? ''}`.trim()}
                      className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary hover:text-danger"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remove this passkey?"
        description={`"${deleteTarget?.friendly_name ?? 'This passkey'}" will no longer be able to sign in to your account. You can still sign in with your other methods.`}
        confirmLabel="Remove passkey"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
