import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CheckCircle2, AlertCircle, Building2, LogOut } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  fetchInviteForToken,
  acceptTeamInvite,
  INVITE_ERROR_MESSAGES,
  PublicInviteInfo,
  AcceptInviteError,
} from '@/lib/invites';
import { setPendingInviteToken } from '@/lib/inviteRedirect';

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  technician: 'Technician',
  member: 'Member',
};

export function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { session, user, loading: authLoading, signOut, refreshProfile } = useAuth();

  const [invite, setInvite] = useState<PublicInviteInfo | null | undefined>(undefined);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<AcceptInviteError | null>(null);

  useEffect(() => {
    if (!token) return;
    fetchInviteForToken(token).then(setInvite);
  }, [token]);

  const handleAccept = async () => {
    if (!token) return;
    setAccepting(true);
    setAcceptError(null);
    const result = await acceptTeamInvite(token);
    if (result.success) {
      await refreshProfile();
      toast(`You're in — welcome to ${result.companyName ?? 'the team'}.`, 'success');
      navigate('/dashboard', { replace: true });
    } else {
      setAcceptError(result.error ?? 'unknown');
    }
    setAccepting(false);
  };

  const goToAuth = (mode: 'login' | 'signup') => {
    if (token) setPendingInviteToken(token);
    navigate(mode === 'login' ? '/login' : '/signup?invited=1');
  };

  const emailMatches =
    !!user?.email && !!invite && user.email.toLowerCase() === invite.member_email.toLowerCase();

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-md rounded-2xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark"
        >
          {invite === undefined && (
            <p className="text-center text-sm text-text-secondary">Loading your invite…</p>
          )}

          {invite === null && (
            <div className="text-center">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">Invite not found</h1>
              <p className="mt-2 text-sm text-text-secondary">
                This link doesn't match an active invite. Ask whoever invited you to resend it.
              </p>
            </div>
          )}

          {invite && invite.invite_status === 'active' && (
            <div className="text-center">
              <CheckCircle2 size={28} className="mx-auto mb-3 text-success-500" />
              <h1 className="text-lg font-semibold text-text-primary">Already accepted</h1>
              <p className="mt-2 text-sm text-text-secondary">
                This invite has already been accepted.{' '}
                {session ? 'Head to your dashboard.' : 'Log in to continue.'}
              </p>
              <Button className="mt-5 w-full" onClick={() => navigate(session ? '/dashboard' : '/login')}>
                {session ? 'Go to dashboard' : 'Log in'}
              </Button>
            </div>
          )}

          {invite && invite.invite_status === 'pending' && invite.is_expired && (
            <div className="text-center">
              <AlertCircle size={28} className="mx-auto mb-3 text-warning-500" />
              <h1 className="text-lg font-semibold text-text-primary">This invite has expired</h1>
              <p className="mt-2 text-sm text-text-secondary">
                Ask {invite.inviter_name ?? 'the account owner'} to send you a new invite from the Team page.
              </p>
            </div>
          )}

          {invite && invite.invite_status === 'pending' && !invite.is_expired && (
            <>
              <div className="mb-5 flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <Building2 size={20} />
                </span>
                <div>
                  <h1 className="text-lg font-semibold text-text-primary">
                    Join {invite.company_name ?? 'the workspace'} on Vireek
                  </h1>
                  <p className="text-xs text-text-secondary">
                    {invite.inviter_name ?? 'Someone'} invited you as{' '}
                    <strong>{ROLE_LABELS[invite.role] ?? invite.role}</strong>
                  </p>
                </div>
              </div>

              <p className="mb-5 rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-secondary">
                This invite is for <strong className="text-text-primary">{invite.member_email}</strong>
              </p>

              {authLoading ? (
                <p className="text-center text-sm text-text-secondary">Checking your session…</p>
              ) : !session ? (
                <div className="flex flex-col gap-2.5">
                  <Button onClick={() => goToAuth('signup')} className="w-full">
                    Create account &amp; accept
                  </Button>
                  <Button onClick={() => goToAuth('login')} variant="secondary" className="w-full">
                    I already have an account
                  </Button>
                </div>
              ) : emailMatches ? (
                <div className="flex flex-col gap-2.5">
                  <Button onClick={handleAccept} disabled={accepting} className="w-full">
                    {accepting ? 'Joining…' : 'Accept invite & join workspace'}
                  </Button>
                  {acceptError && (
                    <p className="text-center text-sm text-danger">{INVITE_ERROR_MESSAGES[acceptError]}</p>
                  )}
                </div>
              ) : (
                <div className="text-center">
                  <p className="mb-4 text-sm text-text-secondary">
                    You're signed in as <strong className="text-text-primary">{user?.email}</strong>, but this
                    invite was sent to {invite.member_email}.
                  </p>
                  <Button onClick={() => signOut()} variant="secondary" className="w-full gap-2">
                    <LogOut size={16} /> Sign out &amp; switch account
                  </Button>
                </div>
              )}
            </>
          )}
        </motion.div>
      </main>
      <Footer />
    </div>
  );
}
