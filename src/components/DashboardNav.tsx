import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BarChart3,
  BookOpen,
  BookMarked,
  ClipboardCheck,
  Phone,
  LogOut,
  Menu,
  X,
  LayoutDashboard,
  Calendar,
  TrendingUp,
  TrendingDown,
  Radio,
  PhoneCall,
  Users,
  Wrench,
  BookUser,
  Brain,
  Settings,
  Lightbulb,
  GraduationCap,
  Gauge,
  Hourglass,
  Waves,
  ShieldCheck,
  Scale,
  Bot,
  CreditCard,
  Plug,
  ChevronDown,
    Star,
  Voicemail,
  PhoneOutgoing,
  Megaphone,
 Award,
   DollarSign,
   Calculator,
   Route,
   AlertOctagon,
   GitBranch,
   ShieldCheck,
  FileText,
  ShieldAlert,
  HeartHandshake,
  ShieldCheck,
  FileClock,
  HandHelping,
  FileSignature,
  Zap,
  Building2,
  Webhook,
  Lock,
  History,
  Activity,
  CloudLightning,
  User,
  Cpu,
  MapPinned,
  Scale,
  Telescope,
  PiggyBank,
  MapPin,
  AlarmClock,
  LifeBuoy,
  Workflow,
  Network,
  Package,
  ArrowRightLeft,
  Truck,
  Fuel,
  ScanEye,
  ClipboardList,
  Navigation,
  Siren,
  Layers,
  GitBranch,
  MousePointerClick,
  Handshake,
  HeartPulse,
  MessageSquareWarning,
  ShieldCheck,
  Target,
  Stethoscope,
  ClipboardCheck,
  Radar,
  Fingerprint,
  Crosshair,
  Microscope,
  Compass,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { NotificationsProvider } from '@/contexts/NotificationsContext';
import { ThemeToggle } from '@/components/ThemeToggle';
import { UpgradeBanner } from '@/components/UpgradeBanner';
import { SurgeModeBanner } from '@/components/SurgeModeBanner';
import { PaymentFailedBanner } from '@/components/PaymentFailedBanner';
import { UsageLimitBanner } from '@/components/UsageLimitBanner';
import { NotificationBell } from '@/components/NotificationBell';
import { AiAssistant } from '@/components/AiAssistant';
import { CommandPalette } from '@/components/CommandPalette';
import { useKeyboardShortcuts, DEFAULT_SHORTCUTS } from '@/lib/keyboardShortcuts';
import { KeyboardShortcutsModal } from '@/components/KeyboardShortcutsModal';

interface NavItem {
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
  requiresPermission?: keyof import('@/contexts/AuthContext').UserPermissions;
  ownerOnly?: boolean;
}

// Primary, daily-use items stay immediately visible at the top level —
// step 16's navigation-simplicity pass. Everything account-management-ish
// (now including Settings/Security, added in steps 13/15) is grouped under
// a single collapsible "Account" section instead of growing the flat list
// further.
const PRIMARY_ITEMS: NavItem[] = [
  { label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Calendar', href: '/dashboard/calendar', icon: Calendar },
  { label: 'My Jobs', href: '/dashboard/jobs', icon: Wrench },
  { label: 'Call History', href: '/dashboard/calls', icon: PhoneCall },
  { label: 'Coaching Reports', href: '/dashboard/coaching-reports', icon: GraduationCap, requiresPermission: 'can_view_billing' },
  { label: 'Price Accuracy', href: '/dashboard/price-accuracy', icon: ShieldCheck, requiresPermission: 'can_view_billing' },
  { label: 'Voicemails', href: '/dashboard/voicemails', icon: Voicemail },
  { label: 'Leads', href: '/dashboard/leads', icon: Users },
  { label: 'Customers', href: '/dashboard/customers', icon: BookUser },
  { label: 'Equipment Intelligence', href: '/dashboard/equipment', icon: Wrench },
  { label: 'Customer Intelligence', href: '/dashboard/customer-intelligence', icon: Brain, requiresPermission: 'can_view_billing' },
  { label: 'Quotes', href: '/dashboard/quotes', icon: FileText },
  { label: 'Outbound Campaigns', href: '/dashboard/outbound-campaigns', icon: PhoneOutgoing },
  { label: 'Marketing Automation', href: '/dashboard/marketing', icon: Megaphone },
  { label: 'Command Center', href: '/dashboard/command-center', icon: Radio },
  { label: 'Analytics', href: '/dashboard/analytics', icon: TrendingUp, requiresPermission: 'can_view_billing' },
  { label: 'Profitability', href: '/dashboard/profitability', icon: DollarSign },
  { label: 'Parts & Inventory', href: '/dashboard/inventory', icon: Package },
  { label: 'Phone Numbers', href: '/dashboard/phone-numbers', icon: Phone },
  { label: 'Usage Dashboard', href: '/dashboard/usage', icon: Gauge, requiresPermission: 'can_view_billing' },
  { label: 'Insights', href: '/dashboard/insights', icon: Lightbulb },
  { label: 'Decision Engine', href: '/dashboard/decision-engine', icon: Cpu, requiresPermission: 'can_view_billing' },
  { label: 'Regret Console', href: '/dashboard/regret-console', icon: Scale, requiresPermission: 'can_view_billing' },
  { label: 'Business Reality', href: '/dashboard/reality', icon: Telescope, requiresPermission: 'can_view_billing' },
  { label: 'Revenue Map', href: '/dashboard/revenue-map', icon: MapPinned, requiresPermission: 'can_view_billing' },
  { label: 'Cash Flow Forecast', href: '/dashboard/cash-flow', icon: PiggyBank, requiresPermission: 'can_view_billing' },
  { label: 'Regional Demand', href: '/dashboard/regional-demand', icon: MapPin, requiresPermission: 'can_view_billing' },
  { label: 'Dispatch Board', href: '/dashboard/dispatch', icon: Route },
  { label: 'Advanced Routing', href: '/dashboard/routing', icon: Navigation },
  { label: 'On-Call Rotation', href: '/dashboard/on-call', icon: AlarmClock },
  { label: 'Mutual Aid', href: '/dashboard/mutual-aid', icon: LifeBuoy },
  { label: 'Contractor Network', href: '/dashboard/network', icon: Network },
  { label: 'Job Handoffs', href: '/dashboard/network/handoffs', icon: ArrowRightLeft },
  { label: 'Insurance Claims', href: '/dashboard/insurance-claims', icon: ShieldAlert },
  { label: 'Compliance Center', href: '/dashboard/compliance', icon: ShieldCheck },
  { label: 'Callback Root-Cause', href: '/dashboard/callback-root-cause', icon: Microscope },
  { label: 'Job Quality Gate', href: '/dashboard/job-quality-gate', icon: ClipboardCheck },
  { label: 'Warranty Claim Recovery', href: '/dashboard/warranty-claims', icon: FileClock },
  { label: 'Service Recovery', href: '/dashboard/service-recovery', icon: HeartHandshake },
  { label: 'Labor Marketplace', href: '/dashboard/labor-marketplace', icon: HandHelping },
  { label: 'Commercial Contracts', href: '/dashboard/contracts', icon: FileSignature },
  { label: 'Reviews', href: '/dashboard/reviews', icon: Star },
  { label: 'Promise Tracker', href: '/dashboard/promises', icon: Handshake },
  { label: 'Service Recovery', href: '/dashboard/service-recovery', icon: MessageSquareWarning },
  { label: 'Memberships', href: '/dashboard/memberships', icon: Award },
  { label: 'Price Book', href: '/dashboard/price-book', icon: DollarSign },
  { label: 'Underpriced Jobs', href: '/dashboard/underpriced-jobs', icon: TrendingDown, requiresPermission: 'can_view_billing' },
  { label: 'Equipment Health', href: '/dashboard/equipment-health', icon: HeartPulse },
  { label: 'Fleet Economics', href: '/dashboard/fleet-economics', icon: Fuel },
  { label: 'Field Evidence', href: '/dashboard/field-evidence', icon: ScanEye },
  { label: 'Customer Trust Bank', href: '/dashboard/trust-bank', icon: ShieldCheck },
  { label: 'Next Best Actions', href: '/dashboard/next-best-actions', icon: Target },
  { label: 'Diagnosis Copilot', href: '/dashboard/diagnosis-copilot', icon: Stethoscope },
  { label: 'Margin Guardrails', href: '/dashboard/margin-guardrails', icon: ShieldCheck, requiresPermission: 'can_view_billing' },
  { label: 'Automation Marketplace', href: '/dashboard/automation-marketplace', icon: Zap },
  { label: 'Company Reflexes', href: '/dashboard/reflexes', icon: Zap },
  { label: 'Workflows', href: '/dashboard/workflows', icon: Workflow },
  { label: 'Workflows', href: '/dashboard/workflows', icon: Workflow },
  { label: 'Franchise Command Center', href: '/dashboard/franchise', icon: Building2 },
  { label: 'Franchise Governance', href: '/dashboard/franchise/governance', icon: Gavel },
  { label: 'Event Bus', href: '/dashboard/event-bus', icon: Webhook },
  { label: 'Reliability & Observability', href: '/dashboard/reliability', icon: Activity },
  { label: 'Activity Ledger', href: '/dashboard/activity-ledger', icon: History },
  { label: 'Technician Capacity', href: '/dashboard/technician-capacity', icon: Lock },
  { label: 'Capacity Demand Control', href: '/dashboard/capacity-demand', icon: Gauge },
  { label: 'Opportunity Cost Ledger', href: '/dashboard/opportunity-cost', icon: Hourglass },
  { label: 'Causal Shock Simulator', href: '/dashboard/causal-shock-simulator', icon: Waves },
  { label: 'Technician Performance', href: '/dashboard/technician-performance', icon: Gauge, requiresPermission: 'can_view_billing' },
  { label: 'Click-to-Cash', href: '/dashboard/click-to-cash', icon: MousePointerClick, requiresPermission: 'can_view_billing' },
  { label: 'Skill Graph', href: '/dashboard/skill-graph', icon: GitBranch, requiresPermission: 'can_view_billing' },
  { label: 'Weather Surge', href: '/dashboard/weather-surge', icon: CloudLightning },
  { label: 'Emergency Operations', href: '/dashboard/emergency-ops', icon: Siren },
  { label: 'Profitability', href: '/dashboard/profitability', icon: Calculator, requiresPermission: 'can_view_billing' },
  { label: 'Knowledge', href: '/dashboard/knowledge', icon: BookOpen },
  { label: 'Recovery Ledger', href: '/dashboard/recovery', icon: TrendingUp, requiresPermission: 'can_view_billing' },
  { label: 'Benchmarks', href: '/dashboard/benchmarks', icon: BarChart3, requiresPermission: 'can_view_billing' },
  { label: 'Business Contradictions', href: '/dashboard/contradictions', icon: AlertOctagon },
  { label: 'Counterfactual Library', href: '/dashboard/counterfactuals', icon: GitBranch },
  { label: 'Commitment Graph', href: '/dashboard/commitments', icon: ShieldCheck },
  { label: 'Evolution Roadmap', href: '/dashboard/roadmap', icon: Compass, requiresPermission: 'can_view_billing' },
  { label: 'Business Constitution', href: '/dashboard/constitution', icon: Scale },
  { label: 'Value at Risk', href: '/dashboard/value-at-risk', icon: Radar, requiresPermission: 'can_view_billing' },
  { label: 'Bottleneck Market Maker', href: '/dashboard/bottleneck-market', icon: Crosshair, requiresPermission: 'can_view_billing' },
  { label: 'Uncertainty & Evidence Map', href: '/dashboard/uncertainty-map', icon: Fingerprint, requiresPermission: 'can_view_billing' },
  { label: 'Playbooks', href: '/dashboard/playbooks', icon: BookMarked, requiresPermission: 'can_edit_business_profile' },
  { label: 'Trade Playbooks', href: '/dashboard/trade-playbooks', icon: ClipboardCheck, requiresPermission: 'can_edit_business_profile' },
  { label: 'Agent Governance', href: '/dashboard/agent-governance', icon: Bot, requiresPermission: 'can_manage_security' },
  { label: 'Vendor & Procurement', href: '/dashboard/procurement', icon: Truck, requiresPermission: 'can_view_billing' },
];


const ACCOUNT_ITEMS: NavItem[] = [
  { label: 'My Account', href: '/dashboard/account', icon: User },
  { label: 'Business Profile', href: '/dashboard/business-profile', icon: Settings, requiresPermission: 'can_edit_business_profile' },
  { label: 'Team', href: '/dashboard/team', icon: ShieldCheck, requiresPermission: 'can_manage_team' },
  { label: 'Billing', href: '/dashboard/billing', icon: CreditCard, requiresPermission: 'can_view_billing' },
  { label: 'Payments', href: '/dashboard/payments', icon: CreditCard, requiresPermission: 'can_view_billing' },
    { label: 'Benchmarks', href: '/dashboard/benchmarks', icon: TrendingUp, requiresPermission: 'can_view_billing' },
  { label: 'Integrations', href: '/dashboard/integrations', icon: Plug },
  { label: 'Settings', href: '/dashboard/settings', icon: Settings },
];

function filterItems(items: NavItem[], isOwner: boolean, permissions: import('@/contexts/AuthContext').UserPermissions) {
  return items.filter((item) => {
    if (item.ownerOnly && !isOwner) return false;
    if (!item.requiresPermission) return true;
    if (isOwner) return true;
    return permissions[item.requiresPermission];
  });
}

export function DashboardNav({ activeLabel }: { activeLabel: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { isOwner, permissions, signOut } = useAuth();
  const { toast } = useToast();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);

  // Power-user keyboard shortcuts (e.g. "g" then "o" for Overview, "?" for
  // this help panel) — wired once here so they work from anywhere in the
  // dashboard, since DashboardNav is mounted by every dashboard page via
  // DashboardLayout below.
  const shortcuts = useMemo(
    () => DEFAULT_SHORTCUTS(navigate, () => setShortcutsHelpOpen(true)),
    [navigate],
  );
  useKeyboardShortcuts(shortcuts);

  const isActive = (href: string) => {
    if (href === '/dashboard') return location.pathname === '/dashboard';
    return location.pathname.startsWith(href);
  };

  const visiblePrimary = filterItems(PRIMARY_ITEMS, isOwner, permissions);
  const visibleAccount = filterItems(ACCOUNT_ITEMS, isOwner, permissions);
  const accountActive = visibleAccount.some((item) => isActive(item.href));
  const [accountOpen, setAccountOpen] = useState(accountActive);

  const handleSignOut = async () => {
    await signOut();
    toast('Signed out successfully.', 'info');
    navigate('/login', { replace: true });
  };

  function NavLink({ item }: { item: NavItem }) {
    const active = isActive(item.href);
    return (
      <Link
        key={item.href}
        to={item.href}
        onClick={() => setDrawerOpen(false)}
        className={`focus-ring flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
          active
            ? 'bg-accent/10 text-accent shadow-sm ring-1 ring-accent/15'
            : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
        }`}
      >
        <item.icon size={18} className={active ? 'text-accent' : 'text-text-secondary'} />
        {item.label}
      </Link>
    );
  }

  const navContent = (
    <nav className="flex flex-col gap-1">
      {visiblePrimary.map((item) => (
        <NavLink key={item.href} item={item} />
      ))}

      {visibleAccount.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setAccountOpen((v) => !v)}
            className="focus-ring flex w-full items-center justify-between rounded-xl px-3 py-2 text-xs font-semibold uppercase tracking-wider text-text-secondary/60 hover:text-text-secondary"
          >
            Account
            <ChevronDown size={14} className={`transition-transform ${accountOpen ? 'rotate-180' : ''}`} />
          </button>
          <AnimatePresence initial={false}>
            {accountOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <div className="flex flex-col gap-1 pt-1">
                  {visibleAccount.map((item) => (
                    <NavLink key={item.href} item={item} />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </nav>
  );

  return (
    <>
      {/* Desktop sidebar */}
            <aside className="fixed left-0 top-0 z-30 hidden h-full w-60 flex-col border-r border-border/80 bg-bg-secondary/95 shadow-sm lg:flex print:hidden">
        <div className="flex items-center justify-between gap-2.5 px-5 py-5">
          <Link to="/dashboard" className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-cta text-white shadow-glow-accent">
              <Phone size={16} strokeWidth={2.5} />
            </span>
            <span className="text-lg font-bold tracking-tight text-text-primary">Vireek</span>
          </Link>
          <NotificationBell />
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
            <header className="sticky top-0 z-40 border-b border-border/80 bg-bg-secondary/85 shadow-sm backdrop-blur-xl lg:hidden print:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Link to="/dashboard" className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-cta text-white shadow-glow-accent">
              <Phone size={16} strokeWidth={2.5} />
            </span>
            <span className="text-lg font-bold tracking-tight text-text-primary">Vireek</span>
          </Link>
          <div className="flex items-center gap-2">
            <NotificationBell />
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
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-cta text-white shadow-glow-accent">
                    <Phone size={16} strokeWidth={2.5} />
                  </span>
                  <span className="text-lg font-bold tracking-tight text-text-primary">Vireek</span>
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

      {/* Keyboard shortcuts help panel — opened via "?" from anywhere */}
      <KeyboardShortcutsModal
        open={shortcutsHelpOpen}
        onClose={() => setShortcutsHelpOpen(false)}
        shortcuts={shortcuts}
      />
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
    // NotificationsProvider wraps everything here (not just <DashboardNav>)
    // because DashboardNav itself renders TWO <NotificationBell /> instances
    // at once (desktop sidebar + mobile header — CSS just hides one of
    // them, both stay mounted). One provider = one realtime subscription
    // shared by both bells, instead of each opening its own and colliding.
    // See NotificationsContext.tsx for the full story on the bug this fixes.
        <NotificationsProvider>
      <div className="min-h-screen bg-bg-primary">
        <DashboardNav activeLabel={activeLabel} />
        <div className="lg:pl-60 print:pl-0">
          <main id="main-content" className="mx-auto max-w-7xl px-4 py-6 lg:px-8 lg:py-8 print:max-w-none print:p-0">
            <div className="no-print">
                            <UpgradeBanner />
              <SurgeModeBanner />
              <PaymentFailedBanner />
              <UsageLimitBanner />             
            </div>
            {children}
          </main>
        </div>
        <div className="no-print">
          <CommandPalette />
          <AiAssistant />
        </div>
      </div>
    </NotificationsProvider>
  );
}
