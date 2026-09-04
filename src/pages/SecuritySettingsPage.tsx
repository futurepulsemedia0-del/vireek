import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, KeyRound, LogOut, ScrollText, CircleCheck as CheckCircle2, Trash2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';

interface AuditLogRow {
  id: string;
  actor_email: string | null;
  action: string;
  target_table: string | null;
  target_id: string | null;
  created_at: string;
}

interface MfaFactor {
  id: string;
  status: string;
  factor_type: string;
}

function ActionLabel(action: string): string {
  return action
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

function AuditLogSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="h-4 w-full animate-pulse rounded bg-bg-tertiary" />
      ))}
    </div>
  );
}

/**
 * Step 15 — account-owner-only security settings: real TOTP 2FA via
 * Supabase Auth's MFA API (no custom crypto, no fragile homegrown
 * implementation — this is exactly what the prompt asked for if native MFA
 * support exists, which it does as of supabase-js v2), a real
 * "sign out everywhere else" action, and a read-only view of the audit log.
 *
 * NOTE on "active sessions": supabase-js does not expose a client-side API
 * to list a user's other sessions/devices individually (that requires the
 * Auth Admin API with a service-role key, which must never run in the
 * browser). Rather than fake a device list we can't actually revoke
 * individually, this page is upfront about that limit and offers the one
 * real, supported action instead: signing out every session except this
 * one in a single click (`supabase.auth.signOut({ scope: 'others' })`).
 */
export function SecuritySettingsPage() {
  const { isOwner, profile, user } = useAuth();
  const { toast } = useToast();

  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [mfaLoading, setMfaLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [pendingFactorId, setPendingFactorId] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [unenrollTarget, setUnenrollTarget] = useState<MfaFactor | null>(null);

  const [auditLog, setAuditLog] = useState<AuditLogRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);

  const [signingOutOthers, setSigningOutOthers] = useState(false);

  const loadFactors = useCallback(async () => {
    setMfaLoading(true);
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (!error && data) {
      setFactors(data.totp as MfaFactor[]);
    }
    setMfaLoading(false);
  }, []);

  const loadAuditLog = useCallback(async () => {
    if (!isOwner || !profile) return;
    setAuditLoading(true);
    const { data, error } = await supabase
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (!error) setAuditLog((data ?? []) as AuditLogRow[]);
    setAuditLoading(false);
  }, [isOwner, profile]);

  useEffect(() => {
    loadFactors();
    loadAuditLog();
  }, [loadFactors, loadAuditLog]);

  if (!isOwner) {
    return (
      <DashboardLayout activeLabel="Security">
        <p className="text-sm text-text-secondary">Only the account owner can view security settings.</p>
      </DashboardLayout>
    );
  }

  const startEnroll = async () => {
    setEnrolling(true);
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
    if (error) {
      toast(
        error.message.includes('not enabled') || error.status === 404
          ? "Two-factor authentication isn't enabled for this Supabase project yet — turn it on under Authentication → MFA in the Supabase dashboard first."
          : `Could not start 2FA setup: ${error.message}`,
        'error'
      );
      setEnrolling(false);
      return;
    }
    setPendingFactorId(data.id);
    setQrCode(data.totp.qr_code);
    setSecret(data.totp.secret);
    setEnrolling(false);
  };

  const confirmEnroll = async () => {
    if (!pendingFactorId || verifyCode.length < 6) return;
    setVerifying(true);
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: pendingFactorId,
      });
      if (challengeError) throw challengeError;

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: pendingFactorId,
        challengeId: challenge.id,
        code: verifyCode,
      });
      if (verifyError) throw verifyError;

      toast('Two-factor authentication is now enabled.', 'success');
      setQrCode(null);
      setSecret(null);
      setPendingFactorId(null);
      setVerifyCode('');
      await loadFactors();
    } catch (err) {
      toast(err instanceof Error ? `Incorrect code: ${err.message}` : 'That code was incorrect.', 'error');
    } finally {
      setVerifying(false);
    }
  };

  const handleUnenroll = async () => {
    if (!unenrollTarget) return;
    const { error } = await supabase.auth.mfa.unenroll({ factorId: unenrollTarget.id });
    if (error) {
      toast(`Could not remove 2FA: ${error.message}`, 'error');
    } else {
      toast('Two-factor authentication removed.', 'info');
      await loadFactors();
    }
    setUnenrollTarget(null);
  };

  const signOutOthers = async () => {
    setSigningOutOthers(true);
    const { error } = await supabase.auth.signOut({ scope: 'others' });
    setSigningOutOthers(false);
    if (error) toast(`Could not sign out other sessions: ${error.message}`, 'error');
    else toast('Every other session has been signed out.', 'success');
  };

  const verifiedFactor = factors.find((f) => f.status === 'verified');

  return (
    <DashboardLayout activeLabel="Security">
      <BackButton fallback="/dashboard/settings" label="Back to Settings" />
      <div className="mb-6 mt-3 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <ShieldCheck size={24} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Security</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Two-factor authentication, sessions, and your account's audit trail.
          </p>
        </div>
      </div>

      {/* 2FA */}
      <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
            <KeyRound size={18} />
          </span>
          <div>
            <h2 className="text-base font-semibold text-text-primary">Two-factor authentication</h2>
            <p className="text-xs text-text-secondary">Require an authenticator app code at sign-in.</p>
          </div>
        </div>

        <div className="mt-4">
          {mfaLoading ? (
            <div className="h-9 w-40 animate-pulse rounded-xl bg-bg-tertiary" />
          ) : verifiedFactor ? (
            <div className="flex items-center justify-between rounded-xl border border-success-500/25 bg-success-500/10 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-success-500">
                <CheckCircle2 size={16} />
                2FA is enabled on your account
              </div>
              <button
                type="button"
                onClick={() => setUnenrollTarget(verifiedFactor)}
                className="focus-ring flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-danger hover:bg-danger/10"
              >
                <Trash2 size={13} />
                Remove
              </button>
            </div>
          ) : qrCode ? (
            <div className="rounded-xl border border-border p-4">
              <p className="text-sm text-text-secondary">
                Scan this with an authenticator app (Google Authenticator, 1Password, Authy), then enter the
                6-digit code it shows.
              </p>
              <div className="mt-3 flex flex-col items-center gap-3 sm:flex-row sm:items-start">
                <img src={qrCode} alt="2FA QR code" className="h-40 w-40 rounded-lg border border-border bg-white p-2" />
                <div className="flex-1 space-y-3">
                  {secret && (
                    <p className="break-all rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
                      Can't scan? Enter manually: <span className="font-mono text-text-primary">{secret}</span>
                    </p>
                  )}
                  <input
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="6-digit code"
                    inputMode="numeric"
                    className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={confirmEnroll}
                      disabled={verifyCode.length < 6 || verifying}
                      className="focus-ring rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      {verifying ? 'Verifying…' : 'Verify & enable'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setQrCode(null);
                        setSecret(null);
                        setPendingFactorId(null);
                        setVerifyCode('');
                      }}
                      className="focus-ring rounded-xl border border-border px-4 py-2 text-sm font-medium text-text-primary"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={startEnroll}
              disabled={enrolling}
              className="focus-ring rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {enrolling ? 'Starting…' : 'Enable two-factor authentication'}
            </button>
          )}
        </div>
      </div>

      {/* Sessions */}
      <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
            <LogOut size={18} />
          </span>
          <div>
            <h2 className="text-base font-semibold text-text-primary">Sessions</h2>
            <p className="text-xs text-text-secondary">You're signed in as {user?.email}.</p>
          </div>
        </div>
        <p className="mt-3 text-sm text-text-secondary">
          If you think another device might be signed into your account, you can sign every other session out
          immediately — this browser stays signed in.
        </p>
        <button
          type="button"
          onClick={signOutOthers}
          disabled={signingOutOthers}
          className="focus-ring mt-3 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary disabled:opacity-50"
        >
          {signingOutOthers ? 'Signing out…' : 'Sign out of all other sessions'}
        </button>
      </div>

      {/* Audit log */}
      <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
            <ScrollText size={18} />
          </span>
          <div>
            <h2 className="text-base font-semibold text-text-primary">Audit log</h2>
            <p className="text-xs text-text-secondary">Sensitive account actions, most recent first.</p>
          </div>
        </div>
        <div className="mt-4">
          {auditLoading ? (
            <AuditLogSkeleton />
          ) : auditLog.length === 0 ? (
            <p className="text-sm text-text-secondary">No sensitive actions recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wider text-text-secondary/70">
                    <th className="pb-2 pr-4 font-semibold">Action</th>
                    <th className="pb-2 pr-4 font-semibold">By</th>
                    <th className="pb-2 font-semibold">When</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLog.map((row) => (
                    <tr key={row.id} className="border-b border-border/60 last:border-0">
                      <td className="py-2.5 pr-4 text-text-primary">{ActionLabel(row.action)}</td>
                      <td className="py-2.5 pr-4 text-text-secondary">{row.actor_email ?? '—'}</td>
                      <td className="py-2.5 text-text-secondary">{new Date(row.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!unenrollTarget}
        title="Remove two-factor authentication?"
        description="Your account will only require a password to sign in. You can re-enable 2FA at any time."
        confirmLabel="Yes, remove 2FA"
        onConfirm={handleUnenroll}
        onCancel={() => setUnenrollTarget(null)}
      />
    </DashboardLayout>
  );
}
