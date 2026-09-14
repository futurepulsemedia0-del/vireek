import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase, Profile, TeamMember } from '@/lib/supabase';

export interface UserPermissions {
  can_view_billing: boolean;
  can_manage_team: boolean;
  can_edit_business_profile: boolean;
  can_view_all_jobs: boolean;
}

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  teamMember: TeamMember | null;
  isOwner: boolean;
  permissions: UserPermissions;
  loading: boolean;
  profileLoading: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const OWNER_PERMISSIONS: UserPermissions = {
  can_view_billing: true,
  can_manage_team: true,
  can_edit_business_profile: true,
  can_view_all_jobs: true,
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [teamMember, setTeamMember] = useState<TeamMember | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);

  // fetchProfile can be triggered from several independent places (initial
  // getSession(), every onAuthStateChange event — including the
  // TOKEN_REFRESHED/SIGNED_IN events supabase-js re-emits when the tab
  // regains focus — and manual refreshProfile() calls after a save). None of
  // those calls are cancelled or sequenced, so if an older call happens to
  // resolve AFTER a newer one (e.g. a focus-triggered refetch that started
  // before the onboarding save landed, but whose response arrives after it),
  // it would blindly overwrite the fresh profile with stale data — which is
  // exactly what caused onboarding_completed to "revert" a few seconds after
  // reaching the dashboard. requestIdRef guards against that: only the
  // response from the most recently *started* call is ever applied.
  const requestIdRef = useRef(0);

  const fetchProfile = useCallback(async (userId: string) => {
    const requestId = ++requestIdRef.current;
    setProfileLoading(true);
    try {
      // The `profiles` row is created by a database trigger right after
      // auth signup (email or OAuth). That trigger can lag the client by a
      // few hundred ms, so a query fired immediately after signup can race
      // it and come back empty. Retry briefly instead of accepting a false
      // "no profile" result — this is what previously caused things like
      // the upgrade banner to silently stay hidden for freshly created
      // (especially Google OAuth) accounts until a manual refresh.
      let prof: Profile | null = null;
      const maxAttempts = 4;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .maybeSingle();
        if (error) throw error;
        prof = data as Profile | null;
        if (prof) break;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        }
      }

      // A newer fetchProfile call has started since this one began — this
      // result is stale, discard it instead of clobbering fresher state.
      if (requestId !== requestIdRef.current) return;

      setProfile(prof);

      // If not an owner, fetch their team_members record for permissions
      if (prof && prof.role !== 'owner') {
        const { data: tmData, error: tmError } = await supabase
          .from('team_members')
          .select('*')
          .eq('member_email', prof.email)
          .maybeSingle();
        if (requestId !== requestIdRef.current) return;
        if (!tmError && tmData) {
          setTeamMember(tmData as TeamMember);
        } else {
          setTeamMember(null);
        }
      } else {
        setTeamMember(null);
      }
    } catch {
      if (requestId !== requestIdRef.current) return;
      setProfile(null);
      setTeamMember(null);
    } finally {
      if (requestId === requestIdRef.current) setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      if (session?.user) {
        fetchProfile(session.user.id);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      (async () => {
        setSession(newSession);
        setUser(newSession?.user ?? null);
        if (newSession?.user) {
          await fetchProfile(newSession.user.id);
        } else {
          setProfile(null);
          setTeamMember(null);
        }
      })();
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [fetchProfile]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setTeamMember(null);
    setSession(null);
    setUser(null);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (user) await fetchProfile(user.id);
  }, [user, fetchProfile]);

  const isOwner = profile?.role === 'owner';
  const permissions: UserPermissions = isOwner
    ? OWNER_PERMISSIONS
    : teamMember?.permissions ?? {
        can_view_billing: false,
        can_manage_team: false,
        can_edit_business_profile: false,
        can_view_all_jobs: false,
      };

  return (
    <AuthContext.Provider
      value={{ session, user, profile, teamMember, isOwner, permissions, loading, profileLoading, signOut, refreshProfile }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
