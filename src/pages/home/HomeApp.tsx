import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { Building2, Home, PlusCircle, ShieldCheck, Sparkles } from 'lucide-react';
import { HomeownerAuthProvider, useHomeowner } from '@/contexts/HomeownerAuthContext';
import { cx, ErrorNote, PrimaryButton, SecondaryButton, Spinner } from './ui';
import { HomeSignInPage } from './HomeSignInPage';
import { HomeOverviewPage } from './HomeOverviewPage';
import { HomeBusinessPage } from './HomeBusinessPage';
import { HomeBusinessesPage } from './HomeBusinessesPage';
import { HomeRequestPage } from './HomeRequestPage';
import { HomeAssistantPage } from './HomeAssistantPage';
import { HomePrivacyPage } from './HomePrivacyPage';

const NAV = [
  { to: '/home', label: 'Home', icon: Home, end: true },
  { to: '/home/businesses', label: 'Providers', icon: Building2, end: false },
  { to: '/home/request', label: 'Request', icon: PlusCircle, end: false },
  { to: '/home/assistant', label: 'Assistant', icon: Sparkles, end: false },
  { to: '/home/privacy', label: 'Privacy', icon: ShieldCheck, end: false },
] as const;

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-bg-primary p-6">{children}</div>;
}

function Shell() {
  const { status, error, refresh, signOut } = useHomeowner();
  const { pathname } = useLocation();
  const onSignIn = pathname.startsWith('/home/sign-in');

  if (status === 'loading') return <Centered><Spinner /></Centered>;
  if (status === 'signed_out') return onSignIn ? <HomeSignInPage /> : <Navigate to="/home/sign-in" replace />;
  if (status === 'blocked') {
    return (
      <Centered>
        <div className="max-w-sm space-y-3 text-center">
          <h1 className="text-lg font-semibold text-text-primary">This is a business account</h1>
          <p className="text-sm text-text-secondary">Vireek Home is for homeowners. Sign out to continue with a mobile number.</p>
          <PrimaryButton onClick={() => void signOut()}>Sign out</PrimaryButton>
        </div>
      </Centered>
    );
  }
  if (status === 'error') {
    return (
      <Centered>
        <div className="w-full max-w-sm space-y-3">
          <ErrorNote message={error ?? 'Could not load your home.'} onRetry={() => void refresh()} />
          <SecondaryButton className="w-full" onClick={() => void signOut()}>Sign out</SecondaryButton>
        </div>
      </Centered>
    );
  }
  if (onSignIn) return <Navigate to="/home" replace />;

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary">
      <main className="mx-auto w-full max-w-2xl px-4 pb-28 pt-[max(1rem,env(safe-area-inset-top))]">
        <Routes>
          <Route index element={<HomeOverviewPage />} />
          <Route path="b/:linkId" element={<HomeBusinessPage />} />
          <Route path="businesses" element={<HomeBusinessesPage />} />
          <Route path="request" element={<HomeRequestPage />} />
          <Route path="assistant" element={<HomeAssistantPage />} />
          <Route path="privacy" element={<HomePrivacyPage />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </main>
      <nav
        aria-label="Vireek Home"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg-secondary/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      >
        <ul className="mx-auto flex max-w-2xl">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <li key={to} className="flex-1">
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  cx(
                    'focus-ring flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium',
                    isActive ? 'text-accent' : 'text-text-secondary',
                  )
                }
              >
                <Icon size={20} aria-hidden />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

export function HomeApp() {
  return (
    <HomeownerAuthProvider>
      <Shell />
    </HomeownerAuthProvider>
  );
}
