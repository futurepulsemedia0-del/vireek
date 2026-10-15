import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AppWindow, Plus, Copy, Check, Trash2, RefreshCw, Pencil, Eye, ShieldCheck, ShieldOff,
  X, KeyRound, Lock, AlertTriangle, Link2,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  OAUTH_SCOPES, OAUTH_SCOPE_LABELS, MAX_REDIRECT_URIS, NAME_MAX, DESCRIPTION_MAX,
  listOAuthApps, listOAuthGrants, createOAuthApp, updateOAuthApp, rotateOAuthSecret,
  setOAuthAppDisabled, deleteOAuthApp, revokeOAuthGrant, revokeAllGrantsForApp,
  validateAppInput, hasErrors, grantStatus,
  type OAuthAppRow, type OAuthGrantRow, type OAuthAppInput, type OAuthAppErrors, type OAuthScope,
} from '@/lib/oauthApps';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string | null): string {
  if (!iso) return 'Never';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const EMPTY_INPUT: OAuthAppInput = {
  name: '', description: '', homepage_url: '', privacy_url: '', terms_url: '',
  redirect_uris: [''], scopes: [],
};

function toInput(app: OAuthAppRow): OAuthAppInput {
  return {
    name: app.name,
    description: app.description,
    homepage_url: app.homepage_url ?? '',
    privacy_url: app.privacy_url ?? '',
    terms_url: app.terms_url ?? '',
    redirect_uris: app.redirect_uris.length ? app.redirect_uris : [''],
    scopes: app.scopes,
  };
}

function hostOf(uri: string): string {
  try { return new URL(uri).host; } catch { return uri; }
}

/** Accessible modal shell — focus trap, Escape, backdrop, scrollable on small screens. */
function Modal({
  title, onClose, children, dismissible = true, labelledBy,
}: { title: string; onClose: () => void; children: ReactNode; dismissible?: boolean; labelledBy: string }) {
  const ref = useFocusTrap(true);
  useEscapeToClose(dismissible, onClose);
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={dismissible ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="relative max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover dark:shadow-card-hover-dark sm:rounded-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={labelledBy} className="text-lg font-bold text-text-primary">{title}</h2>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="focus-ring -mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary"
            >
              <X size={18} />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit form
// ---------------------------------------------------------------------------

function AppFormModal({
  initial, saving, onSubmit, onClose,
}: {
  initial: OAuthAppInput | null;
  saving: boolean;
  onSubmit: (input: OAuthAppInput) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<OAuthAppInput>(initial ?? EMPTY_INPUT);
  const [showErrors, setShowErrors] = useState(false);
  const errors: OAuthAppErrors = useMemo(() => validateAppInput(form), [form]);
  const visible: OAuthAppErrors = showErrors ? errors : {};
  const editing = initial !== null;

  const set = <K extends keyof OAuthAppInput>(key: K, value: OAuthAppInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const setUri = (i: number, value: string) =>
    set('redirect_uris', form.redirect_uris.map((u, idx) => (idx === i ? value : u)));
  const removeUri = (i: number) => {
    const next = form.redirect_uris.filter((_, idx) => idx !== i);
    set('redirect_uris', next.length ? next : ['']);
  };
  const toggleScope = (s: OAuthScope) =>
    set('scopes', form.scopes.includes(s) ? form.scopes.filter((x) => x !== s) : [...form.scopes, s]);

  const submit = () => {
    setShowErrors(true);
    if (hasErrors(errors) || saving) return;
    onSubmit(form);
  };

  return (
    <Modal title={editing ? 'Edit OAuth app' : 'Register an OAuth app'} onClose={onClose} labelledBy="oauth-form-title">
      <div className="mt-5 space-y-4">
        <Input
          label="App name"
          required
          maxLength={NAME_MAX}
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="e.g. Acme CRM Sync"
          error={visible.name}
        />
        <Textarea
          label="Description"
          rows={2}
          maxLength={DESCRIPTION_MAX}
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="Shown to users on the consent screen"
          helperText={`${form.description.length}/${DESCRIPTION_MAX}`}
          error={visible.description}
        />

        <fieldset>
          <legend className="mb-1.5 block text-xs font-medium text-text-secondary">
            Redirect URIs <span aria-hidden="true">*</span>
          </legend>
          <div className="space-y-2">
            {form.redirect_uris.map((uri, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <Input
                    aria-label={`Redirect URI ${i + 1}`}
                    icon={Link2}
                    inputMode="url"
                    autoComplete="off"
                    value={uri}
                    onChange={(e) => setUri(i, e.target.value)}
                    placeholder="https://app.example.com/oauth/callback"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeUri(i)}
                  aria-label={`Remove redirect URI ${i + 1}`}
                  className="focus-ring flex h-[46px] w-10 shrink-0 items-center justify-center rounded-xl border border-border text-text-secondary hover:bg-bg-tertiary"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
          {visible.redirect_uris && (
            <p role="alert" className="mt-1.5 text-xs text-danger">{visible.redirect_uris}</p>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2"
            disabled={form.redirect_uris.length >= MAX_REDIRECT_URIS}
            onClick={() => set('redirect_uris', [...form.redirect_uris, ''])}
          >
            <Plus size={14} /> Add URI
          </Button>
        </fieldset>

        <fieldset>
          <legend className="mb-1.5 block text-xs font-medium text-text-secondary">
            Scopes <span aria-hidden="true">*</span>
          </legend>
          <div className="space-y-2">
            {OAUTH_SCOPES.map((s) => (
              <label key={s} className="flex min-h-[40px] items-start gap-2.5 text-sm text-text-primary">
                <input
                  type="checkbox"
                  checked={form.scopes.includes(s)}
                  onChange={() => toggleScope(s)}
                  className="mt-0.5 h-4 w-4 rounded border-border accent-accent"
                />
                <span>
                  {OAUTH_SCOPE_LABELS[s]}
                  <code className="ml-2 text-xs text-text-secondary">{s}</code>
                </span>
              </label>
            ))}
          </div>
          {visible.scopes && <p role="alert" className="mt-1.5 text-xs text-danger">{visible.scopes}</p>}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Homepage" type="url" value={form.homepage_url} onChange={(e) => set('homepage_url', e.target.value)} placeholder="https://" error={visible.homepage_url} />
          <Input label="Privacy policy" type="url" value={form.privacy_url} onChange={(e) => set('privacy_url', e.target.value)} placeholder="https://" error={visible.privacy_url} />
        </div>
        <Input label="Terms of service" type="url" value={form.terms_url} onChange={(e) => set('terms_url', e.target.value)} placeholder="https://" error={visible.terms_url} />
      </div>

      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button type="button" size="sm" onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Register app'}
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// One-time secret reveal
// ---------------------------------------------------------------------------

function RevealSecretModal({ clientId, secret, onClose }: { clientId: string; secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState<'id' | 'secret' | null>(null);
  const copy = async (kind: 'id' | 'secret', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* clipboard blocked — the value is still selectable on screen */
    }
  };
  const Row = ({ kind, label, value }: { kind: 'id' | 'secret'; label: string; value: string }) => (
    <div>
      <span className="mb-1 block text-xs font-medium text-text-secondary">{label}</span>
      <div className="flex items-center gap-2 rounded-xl border border-border bg-bg-primary p-2.5">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-sm text-text-primary">{value}</code>
        <Button type="button" size="sm" variant="secondary" className="shrink-0 !min-h-[36px] !px-3" onClick={() => copy(kind, value)}>
          {copied === kind ? <Check size={14} /> : <Copy size={14} />}
          {copied === kind ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
  return (
    <Modal title="Copy your client secret now" onClose={onClose} dismissible={false} labelledBy="oauth-secret-title">
      <p className="mt-2 text-sm text-text-secondary">
        This is the only time the secret is shown. Store it somewhere safe — if you lose it, rotate it to get a new one.
      </p>
      <div className="mt-4 space-y-3">
        <Row kind="id" label="Client ID" value={clientId} />
        <Row kind="secret" label="Client secret" value={secret} />
      </div>
      <Button type="button" className="mt-5 w-full" size="sm" onClick={onClose}>I've copied it — close</Button>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Consent screen preview — exactly what an end user is asked to approve
// ---------------------------------------------------------------------------

function ConsentPreviewModal({ app, businessName, onClose }: { app: OAuthAppRow; businessName: string; onClose: () => void }) {
  return (
    <Modal title="Consent screen preview" onClose={onClose} labelledBy="oauth-consent-title">
      <p className="mt-1 text-xs text-text-secondary">This is what people see when {app.name} asks to connect.</p>
      <div className="mt-4 rounded-2xl border border-border bg-bg-primary p-5">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <AppWindow size={20} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text-primary">{app.name}</p>
            <p className="truncate text-xs text-text-secondary">{hostOf(app.redirect_uris[0] ?? '')}</p>
          </div>
        </div>
        <p className="mt-4 text-sm text-text-primary">
          <strong>{app.name}</strong> wants to access <strong>{businessName}</strong> on Vireek.
        </p>
        {app.description && <p className="mt-1.5 text-sm text-text-secondary">{app.description}</p>}
        <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-text-secondary">This will allow the app to</p>
        <ul className="mt-2 space-y-2">
          {app.scopes.map((s) => (
            <li key={s} className="flex items-start gap-2 text-sm text-text-primary">
              <Check size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
              {OAUTH_SCOPE_LABELS[s]}
            </li>
          ))}
        </ul>
        <p className="mt-4 flex items-start gap-2 text-xs text-text-secondary">
          <Lock size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          You can revoke access at any time from Settings → OAuth apps.
        </p>
        <div className="mt-4 flex gap-2">
          <Button type="button" variant="secondary" size="sm" className="flex-1" disabled>Deny</Button>
          <Button type="button" size="sm" className="flex-1" disabled>Allow</Button>
        </div>
        {(app.privacy_url || app.terms_url) && (
          <p className="mt-3 text-center text-xs text-text-secondary">
            {app.privacy_url && <a href={app.privacy_url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Privacy policy</a>}
            {app.privacy_url && app.terms_url && ' · '}
            {app.terms_url && <a href={app.terms_url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Terms</a>}
          </p>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Tab = 'apps' | 'authorizations';
type Pending =
  | { kind: 'delete'; app: OAuthAppRow }
  | { kind: 'disable'; app: OAuthAppRow }
  | { kind: 'rotate'; app: OAuthAppRow }
  | { kind: 'revokeAll'; app: OAuthAppRow }
  | { kind: 'revokeGrant'; grant: OAuthGrantRow; appName: string }
  | null;

export function OAuthAppsPage() {
  const { isOwner, profile } = useAuth();
  const { toast } = useToast();
  const accountOwnerId = isOwner ? profile?.id ?? null : null;

  const [apps, setApps] = useState<OAuthAppRow[]>([]);
  const [grants, setGrants] = useState<OAuthGrantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [tab, setTab] = useState<Tab>('apps');
  const [form, setForm] = useState<{ app: OAuthAppRow | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [reveal, setReveal] = useState<{ clientId: string; secret: string } | null>(null);
  const [preview, setPreview] = useState<OAuthAppRow | null>(null);
  const [pending, setPending] = useState<Pending>(null);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const [a, g] = await Promise.all([listOAuthApps(accountOwnerId), listOAuthGrants(accountOwnerId)]);
      setApps(a);
      setGrants(g);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => { load(); }, [load]);

  const appName = useCallback((id: string) => apps.find((a) => a.id === id)?.name ?? 'Deleted app', [apps]);
  const activeGrantCount = useCallback(
    (id: string) => grants.filter((g) => g.app_id === id && grantStatus(g) === 'active').length,
    [grants],
  );

  if (!isOwner || !accountOwnerId) {
    return (
      <DashboardLayout activeLabel="Settings">
        <EmptyState
          icon={KeyRound}
          title="Owner access only"
          description="OAuth apps can read your account's data on behalf of third parties — only the account owner can register or revoke them."
        />
      </DashboardLayout>
    );
  }

  const handleSave = async (input: OAuthAppInput) => {
    setSaving(true);
    try {
      if (form?.app) {
        await updateOAuthApp(accountOwnerId, form.app.id, input);
        toast('App updated.', 'success');
      } else {
        const { app, rawSecret } = await createOAuthApp(accountOwnerId, input);
        setReveal({ clientId: app.client_id, secret: rawSecret });
        toast('App registered.', 'success');
      }
      setForm(null);
      await load();
    } catch {
      toast('Could not save the app. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleConfirm = async () => {
    if (!pending) return;
    const current = pending;
    try {
      if (current.kind === 'delete') {
        await deleteOAuthApp(accountOwnerId, current.app.id);
        toast('App deleted. All of its tokens are gone.', 'success');
      } else if (current.kind === 'disable') {
        const disabling = !current.app.disabled_at;
        await setOAuthAppDisabled(accountOwnerId, current.app.id, disabling);
        toast(disabling ? 'App disabled and all tokens revoked.' : 'App re-enabled.', 'success');
      } else if (current.kind === 'rotate') {
        const secret = await rotateOAuthSecret(accountOwnerId, current.app.id);
        setReveal({ clientId: current.app.client_id, secret });
        toast('Secret rotated — the old one no longer works.', 'success');
      } else if (current.kind === 'revokeAll') {
        await revokeAllGrantsForApp(accountOwnerId, current.app.id);
        toast('All tokens revoked.', 'success');
      } else {
        await revokeOAuthGrant(accountOwnerId, current.grant.id);
        toast('Token revoked. It stops working immediately.', 'success');
      }
      await load();
    } catch {
      toast('That action failed. Please try again.', 'error');
    } finally {
      setPending(null);
    }
  };

  const confirmCopy = (() => {
    if (!pending) return { title: '', description: '', label: 'Confirm' };
    switch (pending.kind) {
      case 'delete':
        return { title: 'Delete this app?', description: `"${pending.app.name}" and every token it was issued will be permanently removed. Integrations using it will stop working.`, label: 'Delete app' };
      case 'disable':
        return pending.app.disabled_at
          ? { title: 'Re-enable this app?', description: `"${pending.app.name}" will be able to request access again. Previously revoked tokens stay revoked.`, label: 'Re-enable' }
          : { title: 'Disable this app?', description: `"${pending.app.name}" will be blocked and all of its active tokens revoked immediately.`, label: 'Disable app' };
      case 'rotate':
        return { title: 'Rotate client secret?', description: `The current secret for "${pending.app.name}" stops working immediately. Existing tokens are not affected.`, label: 'Rotate secret' };
      case 'revokeAll':
        return { title: 'Revoke all tokens?', description: `Every active token for "${pending.app.name}" will stop working immediately. Users will have to approve access again.`, label: 'Revoke all' };
      default:
        return { title: 'Revoke this token?', description: `This authorization for "${pending.appName}" will stop working immediately.`, label: 'Revoke token' };
    }
  })();

  const activeGrants = grants.filter((g) => grantStatus(g) === 'active');
  const pastGrants = grants.filter((g) => grantStatus(g) !== 'active');

  return (
    <DashboardLayout activeLabel="Settings">
      <div className="mb-6"><BackButton fallback="/dashboard/settings" /></div>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <AppWindow size={24} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">OAuth apps</h1>
            <p className="mt-1 text-sm text-text-secondary">Register apps, control their scopes, and revoke access at any time.</p>
          </div>
        </div>
        <Button type="button" size="sm" className="self-start sm:self-auto" onClick={() => setForm({ app: null })}>
          <Plus size={16} /> Register app
        </Button>
      </div>

      <div role="tablist" aria-label="OAuth sections" className="mb-4 flex gap-1 rounded-xl border border-border bg-bg-secondary p-1">
        {([['apps', `Apps (${apps.length})`], ['authorizations', `Authorizations (${activeGrants.length})`]] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`focus-ring min-h-[40px] flex-1 rounded-lg px-3 text-sm font-medium transition-colors ${tab === id ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <SkeletonCardList count={3} rows={2} />
      ) : loadFailed ? (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load OAuth apps"
          description="Check your connection and try again."
          action={{ label: 'Retry', onClick: load }}
        />
      ) : tab === 'apps' ? (
        apps.length === 0 ? (
          <EmptyState
            icon={AppWindow}
            title="No OAuth apps yet"
            description="Register an app to let a third-party tool request scoped access to your data."
            action={{ label: 'Register your first app', onClick: () => setForm({ app: null }) }}
          />
        ) : (
          <div className="space-y-4">
            {apps.map((app) => {
              const live = activeGrantCount(app.id);
              return (
                <Card key={app.id} className={`!p-5 ${app.disabled_at ? 'opacity-70' : ''}`}>
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold text-text-primary">{app.name}</h2>
                        {app.disabled_at && (
                          <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[0.65rem] font-medium text-danger">Disabled</span>
                        )}
                      </div>
                      {app.description && <p className="mt-1 text-sm text-text-secondary">{app.description}</p>}
                      <dl className="mt-3 space-y-1 text-xs text-text-secondary">
                        <div className="flex flex-wrap gap-x-2"><dt>Client ID</dt><dd><code className="break-all text-text-primary">{app.client_id}</code></dd></div>
                        <div className="flex flex-wrap gap-x-2"><dt>Secret</dt><dd><code className="text-text-primary">{app.client_secret_prefix}••••••••••••</code></dd></div>
                        <div className="flex flex-wrap gap-x-2"><dt>Redirects</dt><dd className="break-all">{app.redirect_uris.join(', ')}</dd></div>
                      </dl>
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {app.scopes.map((s) => (
                          <span key={s} className="rounded-full bg-accent/10 px-2 py-0.5 text-[0.65rem] font-medium text-accent">{s}</span>
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-text-secondary/70">
                        Created {new Date(app.created_at).toLocaleDateString()} · {live} active {live === 1 ? 'token' : 'tokens'}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2 lg:max-w-[260px] lg:justify-end">
                      <Button type="button" size="sm" variant="secondary" className="!min-h-[36px] !px-3 !text-xs" onClick={() => setPreview(app)}><Eye size={13} /> Consent</Button>
                      <Button type="button" size="sm" variant="secondary" className="!min-h-[36px] !px-3 !text-xs" onClick={() => setForm({ app })}><Pencil size={13} /> Edit</Button>
                      <Button type="button" size="sm" variant="secondary" className="!min-h-[36px] !px-3 !text-xs" onClick={() => setPending({ kind: 'rotate', app })}><RefreshCw size={13} /> Rotate</Button>
                      <Button type="button" size="sm" variant="secondary" className="!min-h-[36px] !px-3 !text-xs" onClick={() => setPending({ kind: 'disable', app })}>
                        {app.disabled_at ? <ShieldCheck size={13} /> : <ShieldOff size={13} />}
                        {app.disabled_at ? 'Enable' : 'Disable'}
                      </Button>
                      <Button type="button" size="sm" variant="secondary" className="!min-h-[36px] !px-3 !text-xs" disabled={live === 0} onClick={() => setPending({ kind: 'revokeAll', app })}>Revoke tokens</Button>
                      <Button type="button" size="sm" variant="ghost" className="!min-h-[36px] !px-3 !text-xs !text-danger" onClick={() => setPending({ kind: 'delete', app })}><Trash2 size={13} /> Delete</Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )
      ) : grants.length === 0 ? (
        <EmptyState
          icon={Lock}
          title="No authorizations yet"
          description="When someone approves one of your apps on the consent screen, the token shows up here and can be revoked."
        />
      ) : (
        <div className="space-y-4">
          <Card className="!p-5">
            <h2 className="text-base font-semibold text-text-primary">Active tokens</h2>
            {activeGrants.length === 0 ? (
              <p className="mt-3 text-sm text-text-secondary">No active tokens.</p>
            ) : (
              <div className="mt-3 divide-y divide-border/60">
                {activeGrants.map((g) => (
                  <div key={g.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary">{appName(g.app_id)}</p>
                      <code className="text-xs text-text-secondary">{g.token_prefix}••••••••</code>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {g.scopes.map((s) => <span key={s} className="rounded-full bg-accent/10 px-2 py-0.5 text-[0.65rem] font-medium text-accent">{s}</span>)}
                      </div>
                      <p className="mt-1.5 text-xs text-text-secondary/70">
                        Issued {new Date(g.created_at).toLocaleDateString()} · Last used {timeAgo(g.last_used_at)}
                        {g.expires_at && ` · Expires ${new Date(g.expires_at).toLocaleDateString()}`}
                      </p>
                    </div>
                    <Button type="button" size="sm" variant="secondary" className="!min-h-[36px] !px-3 !text-xs !text-danger self-start sm:self-auto" onClick={() => setPending({ kind: 'revokeGrant', grant: g, appName: appName(g.app_id) })}>
                      <Trash2 size={13} /> Revoke
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>
          {pastGrants.length > 0 && (
            <Card className="!p-5">
              <h2 className="text-sm font-semibold text-text-secondary">Revoked &amp; expired</h2>
              <div className="mt-3 divide-y divide-border/60">
                {pastGrants.map((g) => (
                  <div key={g.id} className="flex items-center justify-between gap-3 py-2.5 opacity-60">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-text-primary">{appName(g.app_id)}</p>
                      <code className="text-xs text-text-secondary">{g.token_prefix}••••••••</code>
                    </div>
                    <span className="shrink-0 text-xs text-text-secondary">
                      {grantStatus(g) === 'revoked' ? `Revoked ${new Date(g.revoked_at!).toLocaleDateString()}` : 'Expired'}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {form && (
        <AppFormModal
          initial={form.app ? toInput(form.app) : null}
          saving={saving}
          onSubmit={handleSave}
          onClose={() => !saving && setForm(null)}
        />
      )}
      {reveal && <RevealSecretModal clientId={reveal.clientId} secret={reveal.secret} onClose={() => setReveal(null)} />}
      {preview && <ConsentPreviewModal app={preview} businessName={profile?.company_name || 'your business'} onClose={() => setPreview(null)} />}

      <ConfirmDialog
        open={!!pending}
        title={confirmCopy.title}
        description={confirmCopy.description}
        confirmLabel={confirmCopy.label}
        onConfirm={handleConfirm}
        onCancel={() => setPending(null)}
      />
    </DashboardLayout>
  );
}
