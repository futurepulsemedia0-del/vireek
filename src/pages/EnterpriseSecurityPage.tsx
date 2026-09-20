import { useCallback, useEffect, useState } from 'react';
import { Building2, Plus, Trash2, Copy, Check, Loader2, ShieldCheck, Users, Globe2, Key } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuth, UserPermissions } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  CustomRole,
  ROLE_PERMISSION_LABELS,
  fetchCustomRoles,
  saveCustomRole,
  deleteCustomRole,
  IpAllowRule,
  fetchIpAllowRules,
  addIpAllowRule,
  deleteIpAllowRule,
  SecurityPolicy,
  fetchSecurityPolicy,
  saveSecurityPolicy,
  SsoDomain,
  fetchSsoDomains,
  registerSsoDomain,
  removeSsoDomain,
  ScimToken,
  fetchScimTokens,
  createScimToken,
  revokeScimToken,
} from '@/lib/enterpriseSecurity';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

type Tab = 'sso' | 'scim' | 'roles' | 'ip' | 'session';

function Section({ title, icon: Icon, children }: { title: string; icon: typeof ShieldCheck; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="mb-4 flex items-center gap-2">
        <Icon size={18} className="text-accent" />
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      </div>
      {children}
    </div>
  );
}

export function EnterpriseSecurityPage() {
  const { user, isOwner } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('sso');

  // SSO
  const [ssoDomains, setSsoDomains] = useState<SsoDomain[]>([]);
  const [newDomain, setNewDomain] = useState('');
  const [newMetadataUrl, setNewMetadataUrl] = useState('');
  const [ssoSaving, setSsoSaving] = useState(false);

  // SCIM
  const [scimTokens, setScimTokens] = useState<ScimToken[]>([]);
  const [newTokenName, setNewTokenName] = useState('');
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);

  // Roles
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [roleName, setRoleName] = useState('');
  const [rolePerms, setRolePerms] = useState<Partial<UserPermissions>>({});
  const [savingRole, setSavingRole] = useState(false);

  // IP allowlist
  const [ipRules, setIpRules] = useState<IpAllowRule[]>([]);
  const [newCidr, setNewCidr] = useState('');
  const [newLabel, setNewLabel] = useState('');

  // Session policy
  const [policy, setPolicy] = useState<SecurityPolicy | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'role' | 'ip' | 'scim' | 'sso'; id: string; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [d, t, r, ip, p] = await Promise.all([
        fetchSsoDomains(),
        fetchScimTokens(),
        fetchCustomRoles(),
        fetchIpAllowRules(),
        fetchSecurityPolicy(),
      ]);
      setSsoDomains(d);
      setScimTokens(t);
      setRoles(r);
      setIpRules(ip);
      setPolicy(p);
    } catch {
      toast('Could not load security settings', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (isOwner) loadAll();
    else setLoading(false);
  }, [isOwner, loadAll]);

  if (!isOwner) {
    return (
      <DashboardLayout>
        <BackButton />
        <p className="mt-6 text-sm text-text-secondary">Only the account owner can manage Enterprise Security settings.</p>
      </DashboardLayout>
    );
  }

  const handleRegisterSso = async () => {
    if (!newDomain.trim() || !newMetadataUrl.trim()) return;
    setSsoSaving(true);
    try {
      await registerSsoDomain(newDomain.trim().toLowerCase(), newMetadataUrl.trim());
      toast('SSO domain registered', 'success');
      setNewDomain('');
      setNewMetadataUrl('');
      loadAll();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not register this domain', 'error');
    } finally {
      setSsoSaving(false);
    }
  };

  const handleCreateToken = async () => {
    if (!user) return;
    try {
      const raw = await createScimToken(user.id, newTokenName);
      setMintedToken(raw);
      setNewTokenName('');
      loadAll();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create this token', 'error');
    }
  };

  const handleCopyToken = async () => {
    if (!mintedToken) return;
    await navigator.clipboard.writeText(mintedToken);
    setCopying(true);
    setTimeout(() => setCopying(false), 1500);
  };

  const handleSaveRole = async () => {
    if (!user || !roleName.trim()) return;
    setSavingRole(true);
    try {
      await saveCustomRole(user.id, roleName, rolePerms);
      toast('Role saved', 'success');
      setRoleName('');
      setRolePerms({});
      loadAll();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save this role', 'error');
    } finally {
      setSavingRole(false);
    }
  };

  const handleAddIpRule = async () => {
    if (!user || !newCidr.trim()) return;
    try {
      await addIpAllowRule(user.id, newCidr, newLabel);
      toast('IP rule added', 'success');
      setNewCidr('');
      setNewLabel('');
      loadAll();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add this rule', 'error');
    }
  };

  const handleSavePolicy = async (patch: Partial<SecurityPolicy>) => {
    if (!user) return;
    setSavingPolicy(true);
    try {
      await saveSecurityPolicy(user.id, patch);
      toast('Session policy saved', 'success');
      loadAll();
    } catch {
      toast('Could not save the session policy', 'error');
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      if (deleteTarget.kind === 'role') await deleteCustomRole(deleteTarget.id);
      if (deleteTarget.kind === 'ip') await deleteIpAllowRule(deleteTarget.id);
      if (deleteTarget.kind === 'scim') await revokeScimToken(deleteTarget.id);
      if (deleteTarget.kind === 'sso') await removeSsoDomain(deleteTarget.label);
      toast('Removed', 'success');
      setDeleteTarget(null);
      loadAll();
    } catch {
      toast('Could not remove this item', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const tabs: { key: Tab; label: string; icon: typeof ShieldCheck }[] = [
    { key: 'sso', label: 'SSO / SAML', icon: Globe2 },
    { key: 'scim', label: 'SCIM', icon: Key },
    { key: 'roles', label: 'Custom roles', icon: Users },
    { key: 'ip', label: 'IP allowlist', icon: ShieldCheck },
    { key: 'session', label: 'Session policy', icon: ShieldCheck },
  ];

  return (
    <DashboardLayout>
      <BackButton />
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Building2 size={20} />
        </span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Enterprise Identity & Security</h1>
          <p className="text-sm text-text-secondary">SSO, SCIM provisioning, granular roles, IP allowlisting, and session policy.</p>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`focus-ring flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.key ? 'bg-accent text-white' : 'bg-bg-secondary text-text-secondary hover:text-text-primary'
            }`}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />
      ) : (
        <>
          {tab === 'sso' && (
            <Section title="SSO / SAML domains" icon={Globe2}>
              <p className="mb-4 text-sm text-text-secondary">
                Let anyone with an email at these domains sign in through your company's identity provider (Okta, Entra ID, etc).
              </p>
              <div className="space-y-2">
                {ssoDomains.length === 0 ? (
                  <p className="text-sm text-text-secondary">No SSO domains configured yet.</p>
                ) : (
                  ssoDomains.map((d) => (
                    <div key={d.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary px-4 py-2.5">
                      <div>
                        <p className="text-sm font-medium text-text-primary">{d.domain}</p>
                        <p className="text-xs text-text-secondary capitalize">{d.status}</p>
                      </div>
                      <button type="button" onClick={() => setDeleteTarget({ kind: 'sso', id: d.id, label: d.domain })} className="focus-ring text-text-secondary hover:text-danger">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <input type="text" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="company.com" className={inputClass} />
                <input type="url" value={newMetadataUrl} onChange={(e) => setNewMetadataUrl(e.target.value)} placeholder="IdP metadata URL" className={inputClass} />
              </div>
              <button
                type="button"
                onClick={handleRegisterSso}
                disabled={ssoSaving}
                className="focus-ring mt-3 flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
              >
                {ssoSaving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Register domain
              </button>
            </Section>
          )}

          {tab === 'scim' && (
            <Section title="SCIM provisioning tokens" icon={Key}>
              <p className="mb-4 text-sm text-text-secondary">
                Give this bearer token to your identity provider to auto-provision and deprovision team members. Endpoint: your Supabase project URL + <code>/functions/v1/scim-v2/Users</code>.
              </p>
              {mintedToken && (
                <div className="mb-4 rounded-xl border border-accent/40 bg-accent/5 p-4">
                  <p className="mb-2 text-xs text-text-secondary">Copy this now — it won't be shown again.</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 truncate rounded-lg bg-bg-primary px-3 py-2 text-xs">{mintedToken}</code>
                    <button type="button" onClick={handleCopyToken} className="focus-ring rounded-lg border border-border p-2 text-text-secondary hover:text-accent">
                      {copying ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                {scimTokens.map((t) => (
                  <div key={t.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary px-4 py-2.5">
                    <div>
                      <p className="text-sm font-medium text-text-primary">{t.name}</p>
                      <p className="text-xs text-text-secondary">{t.revoked_at ? 'Revoked' : t.last_used_at ? `Last used ${new Date(t.last_used_at).toLocaleDateString()}` : 'Never used'}</p>
                    </div>
                    {!t.revoked_at && (
                      <button type="button" onClick={() => setDeleteTarget({ kind: 'scim', id: t.id, label: t.name })} className="focus-ring text-text-secondary hover:text-danger">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-4 flex gap-2">
                <input type="text" value={newTokenName} onChange={(e) => setNewTokenName(e.target.value)} placeholder="Token name, e.g. Okta" className={inputClass} />
                <button type="button" onClick={handleCreateToken} className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110">
                  <Plus size={14} /> Create
                </button>
              </div>
            </Section>
          )}

          {tab === 'roles' && (
            <Section title="Custom roles" icon={Users}>
              <div className="space-y-2">
                {roles.map((r) => (
                  <div key={r.id} className="rounded-xl border border-border bg-bg-primary px-4 py-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-text-primary">{r.name}</p>
                      <button type="button" onClick={() => setDeleteTarget({ kind: 'role', id: r.id, label: r.name })} className="focus-ring text-text-secondary hover:text-danger">
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">
                      {(Object.keys(r.permissions) as (keyof UserPermissions)[]).filter((k) => r.permissions[k]).map((k) => ROLE_PERMISSION_LABELS[k]).join(', ') || 'No permissions granted'}
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-4 rounded-xl border border-dashed border-border p-4">
                <input type="text" value={roleName} onChange={(e) => setRoleName(e.target.value)} placeholder="Role name, e.g. Dispatcher" className={inputClass} />
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {(Object.keys(ROLE_PERMISSION_LABELS) as (keyof UserPermissions)[]).map((key) => (
                    <label key={key} className="flex items-center gap-2 text-sm text-text-primary">
                      <input
                        type="checkbox"
                        checked={Boolean(rolePerms[key])}
                        onChange={(e) => setRolePerms((p) => ({ ...p, [key]: e.target.checked }))}
                      />
                      {ROLE_PERMISSION_LABELS[key]}
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={handleSaveRole}
                  disabled={savingRole}
                  className="focus-ring mt-3 flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
                >
                  {savingRole ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Save role
                </button>
              </div>
            </Section>
          )}

          {tab === 'ip' && (
            <Section title="IP allowlist" icon={ShieldCheck}>
              <p className="mb-4 text-sm text-text-secondary">
                Enable enforcement in the Session policy tab. Add your office/VPN IP ranges below (CIDR notation).
              </p>
              <div className="space-y-2">
                {ipRules.map((r) => (
                  <div key={r.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary px-4 py-2.5">
                    <div>
                      <p className="text-sm font-medium text-text-primary">{r.cidr}</p>
                      {r.label && <p className="text-xs text-text-secondary">{r.label}</p>}
                    </div>
                    <button type="button" onClick={() => setDeleteTarget({ kind: 'ip', id: r.id, label: r.cidr })} className="focus-ring text-text-secondary hover:text-danger">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <input type="text" value={newCidr} onChange={(e) => setNewCidr(e.target.value)} placeholder="203.0.113.0/24" className={inputClass} />
                <input type="text" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Label (optional)" className={inputClass} />
              </div>
              <button type="button" onClick={handleAddIpRule} className="focus-ring mt-3 flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110">
                <Plus size={14} /> Add rule
              </button>
            </Section>
          )}

          {tab === 'session' && policy && (
            <Section title="Session policy" icon={ShieldCheck}>
              <div className="space-y-4">
                <label className="flex items-center justify-between rounded-xl border border-border bg-bg-primary px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-text-primary">Require MFA for all team members</p>
                    <p className="text-xs text-text-secondary">Team members must enable 2FA before they can sign in.</p>
                  </div>
                  <input type="checkbox" checked={policy.require_mfa_for_team} onChange={(e) => handleSavePolicy({ require_mfa_for_team: e.target.checked })} disabled={savingPolicy} />
                </label>

                <label className="flex items-center justify-between rounded-xl border border-border bg-bg-primary px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-text-primary">Enforce IP allowlist</p>
                    <p className="text-xs text-text-secondary">Block access from IPs not in your allowlist.</p>
                  </div>
                  <input type="checkbox" checked={policy.ip_restriction_enabled} onChange={(e) => handleSavePolicy({ ip_restriction_enabled: e.target.checked })} disabled={savingPolicy} />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs text-text-secondary">Idle timeout (minutes, 0 = off)</label>
                    <input
                      type="number"
                      min={0}
                      defaultValue={policy.session_idle_minutes}
                      onBlur={(e) => handleSavePolicy({ session_idle_minutes: Number(e.target.value) || 0 })}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-text-secondary">Max session length (hours, 0 = off)</label>
                    <input
                      type="number"
                      min={0}
                      defaultValue={policy.session_max_hours}
                      onBlur={(e) => handleSavePolicy({ session_max_hours: Number(e.target.value) || 0 })}
                      className={inputClass}
                    />
                  </div>
                </div>
              </div>
            </Section>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title={`Remove ${deleteTarget?.label ?? 'this item'}?`}
        description="This can't be undone."
        confirmLabel="Yes, remove it"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
        loading={deleting}
      />
    </DashboardLayout>
  );
}
