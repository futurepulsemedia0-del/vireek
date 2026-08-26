import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Phone, LogOut, Menu, X, LayoutDashboard, TrendingUp, PhoneCall, Users, Wrench, Settings, Lightbulb, ShieldCheck, CreditCard, Plug, CircleUser as UserCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { ThemeToggle } from '@/components/ThemeToggle';

interface NavItem {
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
  requiresPermission?: keyof import('@/contexts/AuthContext').UserPermissions;
}

const ALL_NAV_ITEMS: NavItem[] = [
  { label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
  { label: 'My Jobs', href: '/dashboard/jobs', icon: Wrench },
  { label: 'Call History', href: '/dashboard/calls', icon: PhoneCall },
  { label: 'Leads', href: '/dashboard/leads', icon: Users },
  { label: 'Analytics', href: '/dashboard/analytics', icon: TrendingUp, requiresPermission: 'can_view_billing' },
  { label: 'Insights', href: '/dashboard/insights', icon: Lightbulb },
  { label: 'Billing', href: '/dashboard/billing', icon: CreditCard, requiresPermission: 'can_view_billing' },
  { label: 'Integrations', href: '/dashboard/integrations', icon: Plug },
  { label: 'Business Profile', href: '/dashboard/business-profile', icon: Settings, requiresPermission: 'can_edit_business_profile' },
  { label: 'Team', href: '/dashboard/team', icon: ShieldCheck, requiresPermission: 'can_manage_team' },
];

export function DashboardNav({ activeLabel }: { activeLabel: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { isOwner, permissions, signOut } = useAuth();
  const { toast } = useToast();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const visibleItems = ALL_NAV_ITEMS.filter((item) => {
    if (!item.requiresPermission) return true;
    if (isOwner) return true;
    return permissions[item.requiresPermission];
  });

  const handleSignOut = async () => {
    await signOut();
    toast('Signed out successfully.', 'info');
    navigate('/login', { replace: true });
  };

  const isActive = (href: string) => {
    if (href === '/dashboard') return location.pathname === '/dashboard';
    return location.pathname.startsWith(href);
  };

  const navContent = (
    <nav className="flex flex-col gap-1">
      {visibleItems.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            to={item.href}
            onClick={() => setDrawerOpen(false)}
            className={`focus-ring flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
              active
                ? 'bg-accent/10 text-accent'
                : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
            }`}
          >
            <item.icon size={18} className={active ? 'text-accent' : 'text-text-secondary'} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed left-0 top-0 z-30 hidden h-full w-60 flex-col border-r border-border bg-bg-secondary lg:flex">
        <div className="flex items-center gap-2.5 px-6 py-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white">
            <Phone size={16} strokeWidth={2.5} />
          </span>
          <span className="text-lg font-bold tracking-tight text-accent">Vireek</span>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-text-secondary/60">
            {activeLabel}
          </p>
          {navContent}
        </div>
        <div className="border-t border-border px-3 py-4">
          <div className="flex items-center gap-3 px-3 pb-3">
            <ThemeToggle />
            <button
              type="button"
              onClick={handleSignOut}
              className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-primary text-text-secondary transition-colors hover:border-danger/40 hover:text-danger"
              aria-label="Sign out"
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile header */}
      <header className="sticky top-0 z-40 border-b border-border bg-bg-primary/80 backdrop-blur-md lg:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Link to="/dashboard" className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white">
              <Phone size={16} strokeWidth={2.5} />
            </span>
            <span className="text-lg font-bold tracking-tight text-accent">Vireek</span>
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-primary"
            >
              <Menu size={18} />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setDrawerOpen(false)}
              className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm lg:hidden"
            />
            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="fixed left-0 top-0 z-50 flex h-full w-72 max-w-[85vw] flex-col border-r border-border bg-bg-secondary lg:hidden"
            >
              <div className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white">
                    <Phone size={16} strokeWidth={2.5} />
                  </span>
                  <span className="text-lg font-bold tracking-tight text-accent">Vireek</span>
                </div>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close menu"
                  className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border text-text-secondary hover:text-text-primary"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-4">
                {navContent}
              </div>
              <div className="border-t border-border px-3 py-4">
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="focus-ring flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                >
                  <LogOut size={18} />
                  Sign out
                </button>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

export function DashboardLayout({
  activeLabel,
  children,
}: {
  activeLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-bg-primary">
      <DashboardNav activeLabel={activeLabel} />
      <div className="lg:pl-60">
        <main className="mx-auto max-w-7xl px-4 py-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
