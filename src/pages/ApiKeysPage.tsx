import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Plus, Copy, Check, Trash2, RefreshCw, Code2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  API_SCOPES, SCOPE_LABELS, ApiScope, ApiKeyRow,
  listApiKeys, createApiKey, revokeApiKey, rotateApiKey,
} from '@/lib/apiKeys';

function NoAccess() {
  return (
    <DashboardLayout activeLabel="Settings">
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
          <KeyRound size={26} />
        </span>
        <h3 className="mt-4 text-lg font-semibold text-text-primary">Owner access only</h3>
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
          API keys grant programmatic access to your account's data — only the account owner can create or revoke them.
        </p>
      </div>
    </DashboardLayout>
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'Never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Modal shown exactly once, right after a key is created or rotated. */
function RevealKeyModal({ rawKey, onClose }: { rawKey: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(rawKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover dark:shadow-card-hover-dark">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-warning-500/10 text-warning-500">
          <KeyRound size={20} />
        </span>
        <h2 className="mt-4 text-lg font-bold text-text-primary">Copy your API key now</h2>
        <p className="mt-1.5 text-sm text-text-secondary">
          This is the only time it will be shown in full. Store it somewhere safe — if you lose it, you'll need to rotate it.
        </p>
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-bg-primary p-3">
          <code className="flex-1 overflow-x-auto whitespace-nowrap text-sm text-text-primary">{rawKey}</code>
          <button
            type="button"
            onClick={copy}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:brightness-110"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="focus-ring mt-5 w-full rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
        >
          I've copied it — close
        </button>
      </div>
    </div>
  );
}

function CreateKeyForm({ onCreate, creating }: { onCreate: (name: string, scopes: ApiScope[]) => void; creating: boolean }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>([...API_SCOPES]);

  const toggleScope = (s: ApiScope) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <h2 className="text-base font-semibold text-text-primary">Create a new API key</h2>
      <div className="mt-4 space-y-4">
        <label className="block text-sm">
          <span className="mb-1.5 block text-xs font-medium text-text-secondary">Key name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Internal CRM sync"
            className="w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus-ring"
          />
        </label>
        <div>
          <span className="mb-1.5 block text-xs font-medium text-text-secondary">Scopes</span>
          <div className="space-y-2">
            {API_SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-2.5 text-sm text-text-primary">
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  onChange={() => toggleScope(s)}
                  className="h-4 w-4 rounded border-border accent-accent"
                />
                {SCOPE_LABELS[s]}
              </label>
            ))}
          </div>
        </div>
        <button
          type="button"
          disabled={!name.trim() || scopes.length === 0 || creating}
          onClick={() => onCreate(name.trim(), scopes)}
          className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
        >
          <Plus size={16} />
          {creating ? 'Creating…' : 'Create key'}
        </button>
      </div>
    </div>
  );
}

export function ApiKeysPage() {
  const { isOwner, user } = useAuth();
  const { toast } = useToast();

  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revealKey, setRevealKey] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<ApiKeyRow | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setKeys(await listApiKeys());
    } catch {
      toast('Could not load API keys.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  if (!isOwner) return <NoAccess />;

  const handleCreate = async (name: string, scopes: ApiScope[]) => {
    if (!user) return;
    setCreating(true);
    try {
      const { rawKey } = await createApiKey(name, scopes, user.id);
      setRevealKey(rawKey);
      await load();
      toast('API key created.', 'success');
    } catch {
      toast('Could not create the key. Please try again.', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async () => {
    if (!confirmRevoke) return;
    try {
      await revokeApiKey(confirmRevoke.id);
      toast('Key revoked. It will stop working immediately.', 'success');
      await load();
    } catch {
      toast('Could not revoke the key.', 'error');
    } finally {
      setConfirmRevoke(null);
    }
  };

  const handleRotate = async (key: ApiKeyRow) => {
    if (!user) return;
    setRotatingId(key.id);
    try {
      const { rawKey } = await rotateApiKey(key.id, key.name, key.scopes, user.id);
      setRevealKey(rawKey);
      await load();
      toast('Key rotated — the old one is now revoked.', 'success');
    } catch {
      toast('Could not rotate the key.', 'error');
    } finally {
      setRotatingId(null);
    }
  };

  const activeKeys = keys.filter((k) => !k.revoked_at);
  const revokedKeys = keys.filter((k) => k.revoked_at);

  return (
    <DashboardLayout activeLabel="Settings">
      <div className="mb-6">
        <BackButton />
      </div>
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <KeyRound size={24} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">API Keys</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Manage programmatic access to your account. See the{' '}
            <a href="/docs" className="font-medium text-accent hover:underline">Developer Docs</a> for endpoint reference.
          </p>
        </div>
      </div>

      <CreateKeyForm onCreate={handleCreate} creating={creating} />

      <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
        <h2 className="text-base font-semibold text-text-primary">Active keys</h2>
        {loading ? (
          <div className="mt-4 space-y-3">
            {[0, 1].map((i) => <div key={i} className="h-12 w-full animate-pulse rounded-xl bg-bg-tertiary" />)}
          </div>
        ) : activeKeys.length === 0 ? (
          <div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed border-border bg-bg-primary p-4">
            <Code2 size={18} className="text-text-secondary" />
            <p className="text-sm text-text-secondary">No active API keys yet. Create one above to get started.</p>
          </div>
        ) : (
          <div className="mt-4 divide-y divide-border/60">
            {activeKeys.map((k) => (
              <div key={k.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text-primary">{k.name}</p>
                  <code className="mt-0.5 block text-xs text-text-secondary">{k.key_prefix}••••••••••••••••••••••••</code>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {k.scopes.map((s) => (
                      <span key={s} className="rounded-full bg-accent/10 px-2 py-0.5 text-[0.65rem] font-medium text-accent">{s}</span>
                    ))}
                  </div>
                  <p className="mt-1.5 text-xs text-text-secondary/70">
                    Created {new Date(k.created_at).toLocaleDateString()} · Last used {timeAgo(k.last_used_at)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleRotate(k)}
                    disabled={rotatingId === k.id}
                    className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-accent/40 disabled:opacity-50"
                  >
                    <RefreshCw size={13} className={rotatingId === k.id ? 'animate-spin' : ''} />
                    Rotate
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRevoke(k)}
                    className="focus-ring flex items-center gap-1.5 rounded-lg border border-danger/30 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
                  >
                    <Trash2 size={13} />
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {revokedKeys.length > 0 && (
        <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
          <h2 className="text-sm font-semibold text-text-secondary">Revoked</h2>
          <div className="mt-3 divide-y divide-border/60">
            {revokedKeys.map((k) => (
              <div key={k.id} className="flex items-center justify-between py-2.5 opacity-60">
                <div>
                  <p className="text-sm text-text-primary">{k.name}</p>
                  <code className="text-xs text-text-secondary">{k.key_prefix}••••••••••••••••••••••••</code>
                </div>
                <span className="text-xs text-text-secondary">
                  Revoked {new Date(k.revoked_at!).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {revealKey && <RevealKeyModal rawKey={revealKey} onClose={() => setRevealKey(null)} />}

      <ConfirmDialog
        open={!!confirmRevoke}
        title="Revoke this API key?"
        description={`"${confirmRevoke?.name}" will stop working immediately. Any integration using it will fail until you issue a new key.`}
        confirmLabel="Revoke key"
        onConfirm={handleRevoke}
        onCancel={() => setConfirmRevoke(null)}
      />
    </DashboardLayout>
  );
}
