import { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, BookOpen, GraduationCap, LogOut, Handshake } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { ThemeToggle } from '@/components/ThemeToggle';

const NAV_ITEMS = [
  { label: 'Overview', href: '/partner-portal', icon: LayoutDashboard },
  { label: 'Referrals', href: '/partner-portal/referrals', icon: Users },
  { label: 'Resources', href: '/partner-portal/resources', icon: BookOpen },
  { label: 'Certification', href: '/partner-portal/certification', icon: GraduationCap },
];

export function PartnerPortalLayout({ children }: { children: ReactNode }) {
  const { signOut } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
    toast('Signed out', 'success');
  };

  return (
    <div className="min-h-screen bg-bg-primary">
      <header className="sticky top-0 z-30 border-b border-border bg-bg-secondary/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 lg:px-8">
          <Link to="/partner-portal" className="focus-ring flex items-center gap-2 rounded-lg">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <Handshake size={18} />
            </span>
            <span className="text-sm font-bold tracking-tight text-text-primary">Vireek Partner Portal</span>
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              type="button"
              onClick={handleSignOut}
              className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:border-danger/40 hover:text-danger"
            >
              <LogOut size={14} /> Sign out
            </button>
          </div>
        </div>
        <nav className="scrollbar-none mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 pb-2 lg:px-8">
          {NAV_ITEMS.map(({ label, href, icon: Icon }) => {
            const active = location.pathname === href;
            return (
              <Link
                key={href}
                to={href}
                className={`focus-ring flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  active ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
              >
                <Icon size={15} />
                {label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 lg:px-8">{children}</main>
    </div>
  );
}
