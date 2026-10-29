import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { reauthGate } from '@/lib/session/reauthGate';
import { classifySignOut, isTerminalRefreshError, needsRefresh } from '@/lib/session/sessionHealth';
import {
  broadcastAuth,
  clearIntentionalSignOut,
  isIntentionalSignOut,
  listenAuthBroadcast,
  markIntentionalSignOut,
} from '@/lib/session/signOutIntent';
import { ReauthModal } from '@/components/session/ReauthModal';

const CHECK_MS = 30_000;

/** Mount once, inside <AuthProvider> and <BrowserRouter>. */
export function SessionGuard() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const hadSession = useRef(false);
  const hasSession = Boolean(session);

  useEffect(() => {
    hadSession.current = hasSession;
    reauthGate.setEnabled(hasSession);
    reauthGate.rememberEmail(session?.user?.email);
    reauthGate.rememberUser(session?.user?.id);
  }, [hasSession, session?.user?.email, session?.user?.id]);

  // Proactive: refresh before expiry; surface terminal refresh failures immediately.
  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    const check = async () => {
      if (cancelled || reauthGate.isOpen() || document.visibilityState === 'hidden') return;
      const { data } = await supabase.auth.getSession();
      const current = data.session;
      if (!current || !needsRefresh(current.expires_at, Date.now())) return;
      const { error } = await supabase.auth.refreshSession();
      if (!cancelled && error && isTerminalRefreshError(error)) void reauthGate.request('expired');
    };
    const id = window.setInterval(() => void check(), CHECK_MS);
    const onVisible = () => void check();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    void check();
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [hasSession]);

  // Forced sign-out + multi-tab sync.
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        clearIntentionalSignOut();
        if (reauthGate.isOpen()) reauthGate.resolve(true); // signed in from another tab/method
        broadcastAuth({ type: 'signed-in' });
        return;
      }
      if (classifySignOut(event, hadSession.current, isIntentionalSignOut()) === 'expired') {
        void reauthGate.request('revoked');
      }
    });
    const stopBroadcast = listenAuthBroadcast((m) => {
      if (m.type === 'signed-out' && hadSession.current) {
        // "Log out everywhere": another tab signed out on purpose.
        markIntentionalSignOut();
        reauthGate.resolve(false);
        navigate('/login?reason=signed_out_elsewhere', { replace: true });
      }
      if (m.type === 'signed-in' && reauthGate.isOpen()) {
        void supabase.auth.getSession().then(({ data: s }) => {
          if (s.session) reauthGate.resolve(true);
        });
      }
    });
    return () => {
      data.subscription.unsubscribe();
      stopBroadcast();
    };
  }, [navigate]);

  return <ReauthModal />;
}
