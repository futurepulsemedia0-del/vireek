import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { usePartsSourcingEnabled } from '@/hooks/usePartsSourcingEnabled';
import { Breadcrumbs } from '@/components/nav/Breadcrumbs';
import { useFeatureFlags } from '@/hooks/useFeatureFlag';
import { Bug } from 'lucide-react';
import { usePestOpsAccess } from '@/hooks/usePestOpsAccess';
import { Leaf } from 'lucide-react';
import { useLandscapingAccess } from '@/lib/landscapingApi';
import {
  BarChart3, Ruler, FileUp, LayoutTemplate, Globe, Globe2, BookOpen, BookMarked, ClipboardCheck, Link2, QrCode,
  ScrollText, Home, Phone, LogOut, Menu, X, LayoutDashboard, Calendar, TrendingUp, TrendingDown, Radio, PhoneCall,
  PhoneMissed, Inbox, Target, Users, Wrench, Medal, BookUser, Settings, Lightbulb, GraduationCap,
  BookOpenCheck, Gauge, Compass, Hourglass, Waves, ShieldCheck, Scale, BadgePercent, Tags, TicketPercent,
  FlaskConical, FolderLock, Ban, Users2, CreditCard, MessagesSquare, Plug, PlugZap, ChevronDown, ChevronRight, ChevronLeft, ChevronsUpDown, Search, Keyboard,
  Headset, BadgeCheck, Rocket, Timer, Star, Smile, Voicemail, PhoneOutgoing, Gift, AudioLines,
  Volume2, Megaphone, MailPlus, Mail, Filter, Award, RotateCcw, DollarSign, Calculator, Route, AlertOctagon,
  GitBranch, FileText, FileBarChart, CalendarClock, ShieldAlert, HeartHandshake, SearchCheck, FileClock,
  HandHelping, FileSignature, Zap, Building2, Webhook, Lock, LockKeyhole, History, Activity, CloudLightning, User,
  Cpu, MapPinned, Telescope, DatabaseZap, Database, PiggyBank, Wallet, Flame, Landmark, MapPin, AlarmClock,
  BellRing, LifeBuoy, Workflow, Network, Package, ArrowRightLeft, Shuffle, Truck, Fuel, ScanEye, ClipboardList,
  ListChecks, CalendarCheck, Navigation, Siren, Layers, FolderKanban, MousePointerClick, Library, Handshake, Store,
  PackageSearch, HeartPulse, Factory, MessageSquareWarning, CalendarOff, MessageSquareText, MessageSquareHeart,
  MessageSquare, Stethoscope, Radar, Fingerprint, Dna, Crosshair, Microscope, MessageCircle, Receipt, Coins,
  Percent, Monitor, Skull, FileSearch, FileCheck2, UserMinus, Infinity as InfinityIcon,
  Satellite, Beaker, Undo2, Trash2, GitMerge, FolderDown, SlidersHorizontal, Images, Camera, Paintbrush,
  CalendarHeart, Trophy, Eye, Banknote, Snowflake, PackageCheck, Coffee, Landmark as ValuationIcon, Mic, Crown,
  DoorOpen, CalendarRange, Warehouse, PencilRuler, Languages, Smartphone, Briefcase, Repeat, Video, RefreshCw,
  Gavel,
} from 'lucide-react';
import '@/components/loading/loading.css';
import { Logo } from '@/components/brand/Logo';
import { ImpersonationBanner } from '@/components/staff/ImpersonationBanner';
import { useAuth } from '@/contexts/AuthContext';
import { rememberDashboardPath } from '@/lib/helpCenter';
import { useToast } from '@/contexts/ToastContext';
import { NotificationsProvider } from '@/contexts/NotificationsContext';
import { ThemeSegmentedControl } from '@/components/ThemeSegmentedControl';
import { UpgradeBanner } from '@/components/UpgradeBanner';
import { SecurityAlertBanner } from '@/components/security/SecurityAlertBanner';
import { IncidentBanner } from '@/components/status/IncidentBanner';
import { SupportDock } from '@/components/support/SupportDock';
import { SurgeModeBanner } from '@/components/SurgeModeBanner';
import { ActivePlaybookBanner } from '@/components/playbooks/ActivePlaybookBanner';
import { PaymentFailedBanner } from '@/components/PaymentFailedBanner';
import { UsageLimitBanner } from '@/components/UsageLimitBanner';
import { TrialBanner } from '@/components/TrialBanner';
import { NotificationBell } from '@/components/NotificationBell';
import { WhatsNewButton } from '@/components/whats-new/WhatsNewButton';
import { ReplayTourMenu } from '@/components/tour/ReplayTourMenu';
import { WhatsNewProvider } from '@/contexts/WhatsNewContext';
import { LocationSwitcher } from '@/components/locations/LocationSwitcher';
import { AiAssistant } from '@/components/AiAssistant';
import { GlobalSearchPalette, openPalette } from '@/components/GlobalSearchPalette';
import { NpsPrompt } from '@/components/success/NpsPrompt';
import { FeedbackButton } from '@/components/feedback/FeedbackButton';
import { FeedbackDialog } from '@/components/feedback/FeedbackDialog';
import { SurveyHost } from '@/components/feedback/SurveyHost';
import { WhatsNewDrawer } from '@/components/whats-new/WhatsNewDrawer';
import { TaskReminderWatcher } from '@/components/tasks/TaskReminderWatcher';
import { ChatUnreadProvider } from '@/contexts/ChatUnreadContext';
import { ChatNavBadge } from '@/components/teamchat/ChatNavBadge';
import { navigationHandlers } from '@/lib/shortcuts/definitions';
import { useShortcutContext, useShortcutHandlers, useShortcutScope } from '@/lib/shortcuts/useShortcuts';
import { KeyboardShortcutsModal } from '@/components/KeyboardShortcutsModal';
import { useTranslation } from 'react-i18next';
import { useDirection } from '@/hooks/useDirection';
import { useEntitlements } from '@/hooks/useEntitlement';
import { passesModuleGate } from '@/lib/entitlements';
import { navLabelKey } from '@/lib/navLabel';
import { PILLARS, audienceFor, groupByPillar, isLab, pillarFor, plainLabel, searchTerms } from '@/lib/surface/surface';
import type { PillarId } from '@/lib/surface/surface';
import { Accessibility as AccessibilityIcon, MessageCircle as AskDataIcon } from 'lucide-react';
import { openAccessibilityCenter, openAskData } from '@/lib/uiEvents';
import { groupByHub } from '@/lib/surface/navHubs';
import { useSimpleMode } from '@/hooks/useSimpleMode';
import { filterToSimpleNav } from '@/lib/simpleMode';
import { MobileBottomNav } from '@/components/mobile/MobileBottomNav';
import { FrequentPages } from '@/components/nav/FrequentPages';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { isNavItemActive } from '@/lib/navActive';
import { navIcon } from '@/lib/surface/navIcons';
import { PwaInstallBanner } from '@/components/mobile/PwaInstallBanner';

interface NavItem {
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
  requiresPermission?: keyof import('@/contexts/AuthContext').UserPermissions;
  ownerOnly?: boolean;
  /** Hidden unless this feature flag is on for the account. Fails closed. */
  flag?: string;
  /** Hidden unless this module is enabled for the account (see filterItems' 4th argument). */
  hiddenUnless?: 'pest_ops';
  /** Hidden unless the account is entitled to this module. */
  requiresModule?: string;
  /** Hidden unless this feature flag is ON for the tenant. */
  requiresFlag?: string;
  gate?: 'landscaping';
}

// Primary, daily-use items stay immediately visible at the top level —
// step 16's navigation-simplicity pass. Everything account-management-ish
// (now including Settings/Security, added in steps 13/15) is grouped under
// a single collapsible "Account" section instead of growing the flat list
// further.
export const PRIMARY_ITEMS: NavItem[] = [
  { label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Support', href: '/dashboard/support', icon: LifeBuoy },
  { label: 'Getting Started', href: '/dashboard/getting-started', icon: Rocket },
  { label: 'Sarah Knowledge', href: '/dashboard/sarah', icon: BookOpenCheck, requiresPermission: 'can_edit_business_profile' },
  { label: 'Success Center', href: '/dashboard/success', icon: TrendingUp },
  { label: 'Calendar', href: '/dashboard/calendar', icon: Calendar },
  { label: 'Calendar Feeds', href: '/dashboard/calendar-feeds', icon: Calendar },
  { label: 'My Jobs', href: '/dashboard/jobs', icon: Wrench },
  { label: 'Inspection Reports', href: '/dashboard/inspection-reports', icon: ClipboardCheck, requiresPermission: 'can_view_all_jobs' },
  { label: 'Job Summaries', href: '/dashboard/job-summaries', icon: ClipboardCheck, requiresPermission: 'can_view_all_jobs' },
  { label: 'Findings Packages', href: '/dashboard/findings', icon: Camera },
  { label: 'Win Cards', href: '/dashboard/win-cards', icon: Trophy },
  { label: 'Site Sketches', href: '/dashboard/site-sketches', icon: PencilRuler },
  { label: 'In-Home Sales', href: '/dashboard/sales', icon: Handshake },
  { label: 'Reputation', href: '/dashboard/reputation', icon: Star, requiresPermission: 'can_edit_business_profile' },
  { label: 'Review Shield', href: '/dashboard/review-shield', icon: ShieldCheck, requiresPermission: 'can_edit_business_profile' },
  { label: 'Listings', href: '/dashboard/listings', icon: MapPin, requiresPermission: 'can_edit_business_profile' },
  { label: 'Install Projects', href: '/dashboard/projects', icon: FolderKanban, requiresPermission: 'can_view_billing' },
  { label: 'Change Orders', href: '/dashboard/change-orders', icon: FileText, requiresPermission: 'can_view_billing' },
  { label: 'Tasks', href: '/dashboard/tasks', icon: ListChecks },
  { label: 'Operating Cadence', href: '/dashboard/cadence', icon: CalendarCheck },
  { label: 'Team Chat', href: '/dashboard/team-chat', icon: MessagesSquare },
  { label: 'Live Calls', href: '/dashboard/live-calls', icon: Radio, requiresPermission: 'can_manage_numbers' },
  { label: 'Mass Incidents', href: '/dashboard/mass-incidents', icon: Siren, requiresPermission: 'can_manage_numbers' },
  { label: 'Live Interpreter', href: '/dashboard/interpreter', icon: Languages, requiresPermission: 'can_manage_numbers' },
  { label: 'Wallboard (TV)', href: '/dashboard/wallboard', icon: Monitor, ownerOnly: true },
  { label: 'Call History', href: '/dashboard/calls', icon: PhoneCall },
  { label: 'Call Scripts', href: '/dashboard/call-scripts', icon: ScrollText, requiresPermission: 'can_edit_business_profile' },
  { label: 'Shadow Mode', href: '/dashboard/shadow-mode', icon: Eye, requiresPermission: 'can_edit_business_profile' },
  { label: 'AI Quality', href: '/dashboard/ai-quality', icon: Gauge, requiresPermission: 'can_edit_business_profile' },
  { label: 'AI Disclosure Ledger', href: '/dashboard/ai-disclosure-ledger', icon: ShieldCheck, requiresPermission: 'can_edit_business_profile' },
  { label: 'CSR Phone Desk', href: '/dashboard/csr-desk', icon: Headset, requiresPermission: 'can_view_all_jobs' },
  { label: 'Leaderboard', href: '/dashboard/leaderboard', icon: Medal },
  { label: 'Inbox', href: '/dashboard/inbox', icon: Inbox },
  { label: 'Goals', href: '/dashboard/goals', icon: Target },
  { label: 'Coaching Reports', href: '/dashboard/coaching-reports', icon: GraduationCap, requiresPermission: 'can_view_billing' },
  { label: 'Price Accuracy', href: '/dashboard/price-accuracy', icon: ShieldCheck, requiresPermission: 'can_view_billing' },
  { label: 'Price Playbook', href: '/dashboard/price-playbook', icon: Scale, requiresPermission: 'can_view_billing' },
  { label: 'Voicemails', href: '/dashboard/voicemails', icon: Voicemail },
  { label: 'Leads', href: '/dashboard/leads', icon: Users },
  { label: 'Lead Assignment', href: '/dashboard/lead-assignment', icon: Shuffle, requiresPermission: 'can_manage_team' },
  { label: 'Customers', href: '/dashboard/customers', icon: BookUser },
  { label: 'Equipment Intelligence', href: '/dashboard/equipment', icon: Wrench },
  { label: 'Building Telemetry', href: '/dashboard/building-telemetry', icon: Cpu },
  { label: 'Customer Intelligence', href: '/dashboard/customer-intelligence', icon: SearchCheck, requiresPermission: 'can_view_billing' },
  { label: 'Quotes', href: '/dashboard/quotes', icon: FileText },
  { label: 'Outbound Campaigns', href: '/dashboard/outbound-campaigns', icon: PhoneOutgoing },
  { label: 'Voice Brand', href: '/dashboard/voice-brand', icon: Volume2, requiresPermission: 'can_view_billing' },
  { label: 'Voicemail Drops', href: '/dashboard/voicemail-drops', icon: AudioLines, requiresPermission: 'can_view_billing' },
  { label: 'Power Dialer', href: '/dashboard/power-dialer', icon: PhoneOutgoing, requiresPermission: 'can_view_all_jobs' },
  { label: 'Call Masking', href: '/dashboard/call-masking', icon: ShieldCheck },
  { label: 'AI Agent Callers', href: '/dashboard/ai-agent-callers', icon: Headset },
  { label: 'Speed to Lead', href: '/dashboard/speed-to-lead', icon: Zap, requiresPermission: 'can_view_billing' },
  { label: 'Leak Report', href: '/dashboard/leak-report', icon: PhoneMissed, requiresPermission: 'can_view_billing' },
  { label: 'Neighborhood Revenue', href: '/dashboard/neighborhood-revenue', icon: MapPinned, requiresPermission: 'can_view_billing' },
  { label: 'Marketing Automation', href: '/dashboard/marketing', icon: Megaphone },
  { label: 'Content Calendar', href: '/dashboard/marketing/calendar', icon: CalendarRange, requiresPermission: 'can_edit_business_profile' },
  { label: 'Creative Studio', href: '/dashboard/marketing/creative', icon: Paintbrush, requiresPermission: 'can_edit_business_profile' },
  { label: 'Lifecycle Touches', href: '/dashboard/lifecycle', icon: CalendarHeart },
  { label: 'Referrals', href: '/dashboard/referrals', icon: Gift, requiresPermission: 'can_view_billing' },
  { label: 'Loyalty', href: '/dashboard/loyalty', icon: Crown, requiresPermission: 'can_view_billing' },
  { label: 'Email Campaigns', href: '/dashboard/email-campaigns', icon: MailPlus, requiresPermission: 'can_view_billing' },
  { label: 'Direct Mail', href: '/dashboard/direct-mail', icon: MailPlus, requiresPermission: 'can_view_billing' },
  { label: 'Work-Order Guard', href: '/dashboard/work-order-guard', icon: ShieldCheck, requiresPermission: 'can_view_billing' },
  { label: 'Canvassing', href: '/dashboard/marketing/canvassing', icon: DoorOpen },
  { label: 'Audiences', href: '/dashboard/audiences', icon: Filter, requiresPermission: 'can_view_billing' },
  { label: 'Landing Pages', href: '/dashboard/landing-pages', icon: LayoutTemplate, requiresPermission: 'can_edit_business_profile' },
  { label: 'Command Center', href: '/dashboard/command-center', icon: Radio },
  { label: 'Analytics', href: '/dashboard/analytics', icon: TrendingUp, requiresPermission: 'can_view_billing' },
  { label: 'Shared Snapshots', href: '/dashboard/snapshots', icon: Link2, requiresPermission: 'can_view_billing' },
  { label: 'Reports', href: '/dashboard/reports', icon: FileBarChart, requiresPermission: 'can_view_billing' },
  { label: 'Scheduled Reports', href: '/dashboard/reports/scheduled', icon: CalendarClock, requiresPermission: 'can_view_billing' },
  { label: 'Profitability', href: '/dashboard/profitability', icon: DollarSign },
  { label: 'Live Service Twins', href: '/dashboard/service-twin', icon: Activity },
  { label: 'Economic Autopilot', href: '/dashboard/economic-autopilot', icon: Rocket, requiresPermission: 'can_view_billing' },
  { label: 'Parts & Inventory', href: '/dashboard/inventory', icon: Package },
  { label: 'Cycle Counts', href: '/dashboard/inventory/counts', icon: ClipboardCheck },
  { label: 'Vendor Returns', href: '/dashboard/inventory/rma', icon: Undo2 },
  { label: 'Tool Crib', href: '/dashboard/tools', icon: Wrench },
  { label: 'Break Compliance', href: '/dashboard/break-compliance', icon: Coffee, requiresPermission: 'can_view_billing' },
  { label: 'Truck Operations', href: '/dashboard/inventory/trucks', icon: Truck },
  { label: 'Phone Numbers', href: '/dashboard/phone-numbers', icon: Phone },
  { label: 'Phone Resilience', href: '/dashboard/voice-resilience', icon: ShieldCheck, requiresPermission: 'can_edit_business_profile' },
  { label: 'Number Reputation', href: '/dashboard/phone-numbers/reputation', icon: ShieldCheck, requiresPermission: 'can_manage_numbers' },
  { label: 'Voice Platform', href: '/dashboard/voice-platform', icon: Mic, requiresPermission: 'can_manage_numbers' },
  { label: 'Blocklist & DNC', href: '/dashboard/blocklist', icon: Ban, requiresPermission: 'can_manage_numbers' },
  { label: 'Call Routing', href: '/dashboard/call-routing', icon: Workflow, requiresPermission: 'can_manage_numbers' },
  { label: 'Call Flows', href: '/dashboard/calls/flows', icon: GitBranch, requiresPermission: 'can_manage_numbers' },
  { label: 'Usage Dashboard', href: '/dashboard/usage', icon: Gauge, requiresPermission: 'can_view_billing' },
  { label: 'Insights', href: '/dashboard/insights', icon: Lightbulb },
  { label: 'Chief of Staff', href: '/dashboard/chief-of-staff', icon: Compass },
  { label: 'Decision Engine', href: '/dashboard/decision-engine', icon: Cpu, requiresPermission: 'can_view_billing' },
  { label: 'Ask Vireek', href: '/dashboard/ask-vireek', icon: MessageSquareText, requiresPermission: 'can_view_billing' },
  { label: 'Causal World Simulator', href: '/dashboard/causal-simulator', icon: GitBranch, requiresPermission: 'can_view_billing' },
  { label: 'Continual Identity Learner', href: '/dashboard/identity-learner', icon: Radar, requiresPermission: 'can_view_billing' },
  { label: 'Regret Console', href: '/dashboard/regret-console', icon: Scale, requiresPermission: 'can_view_billing' },
  { label: 'Business Scientist', href: '/dashboard/business-scientist', icon: FlaskConical, requiresPermission: 'can_view_billing' },
  { label: 'AI Field Scientist', href: '/dashboard/field-scientist', icon: Microscope, requiresPermission: 'can_view_billing' },
  { label: 'Self-Evolving Operating Model', href: '/dashboard/operating-model', icon: Workflow, requiresPermission: 'can_view_billing' },
  { label: 'Decision Debt', href: '/dashboard/decision-debt', icon: Hourglass, requiresPermission: 'can_view_billing' },
  { label: 'Operations Center', href: '/dashboard/operations-center', icon: Radar, requiresPermission: 'can_view_billing' },
  { label: 'Decision Ledger', href: '/dashboard/decision-ledger', icon: ScrollText, requiresPermission: 'can_view_billing' },
  { label: 'Outcome Pricing', href: '/dashboard/outcome-pricing', icon: Gauge, requiresPermission: 'can_view_billing' },
  { label: 'Customer Trust Layer', href: '/dashboard/trust-layer', icon: ShieldCheck },
  { label: 'Service Graph', href: '/dashboard/service-graph', icon: Network, requiresPermission: 'can_view_billing' },
  { label: 'Data Fabric', href: '/dashboard/data-fabric', icon: Layers, requiresPermission: 'can_view_billing' },
  { label: 'Operational Entropy', href: '/dashboard/entropy', icon: Activity, requiresPermission: 'can_view_billing' },
  { label: 'Business Digital Twin', href: '/dashboard/digital-twin', icon: Layers, requiresPermission: 'can_view_billing' },
  { label: 'Business World Model', href: '/dashboard/world-model', icon: Network, requiresPermission: 'can_view_billing' },
  { label: 'Business Reality', href: '/dashboard/reality', icon: Telescope, requiresPermission: 'can_view_billing' },
  { label: 'Data Quality', href: '/dashboard/data-quality', icon: DatabaseZap, requiresPermission: 'can_view_billing' },
  { label: 'Revenue Map', href: '/dashboard/revenue-map', icon: MapPinned, requiresPermission: 'can_view_billing' },
  { label: 'Cash Flow Forecast', href: '/dashboard/cash-flow', icon: PiggyBank, requiresPermission: 'can_view_billing' },
  { label: 'Business Forecast', href: '/dashboard/business-forecast', icon: TrendingUp, requiresPermission: 'can_view_billing' },
  { label: 'Cash Flow War Room', href: '/dashboard/cash-flow-war-room', icon: Flame, requiresPermission: 'can_view_billing' },
  { label: 'Direct Bank Intelligence', href: '/dashboard/bank-intelligence', icon: Landmark, requiresPermission: 'can_view_billing' },
  { label: 'Regional Demand', href: '/dashboard/regional-demand', icon: MapPin, requiresPermission: 'can_view_billing' },
  { label: 'Dispatch Board', href: '/dashboard/dispatch', icon: Route },
  { label: 'Dispatch Rules', href: '/dashboard/assignment-rules', icon: SlidersHorizontal, requiresPermission: 'can_manage_team' },
  { label: 'Context Engine', href: '/dashboard/context-engine', icon: Radar },
  { label: 'Advanced Routing', href: '/dashboard/routing', icon: Navigation },
  { label: 'Service Areas', href: '/dashboard/service-areas', icon: MapPinned, requiresPermission: 'can_view_all_jobs' },
  { label: 'On-Call Rotation', href: '/dashboard/on-call', icon: AlarmClock },
  { label: 'Notification Routing', href: '/dashboard/notification-routing', icon: BellRing, ownerOnly: true },
  { label: 'Mobile Alerts', href: '/dashboard/mobile-alerts', icon: Smartphone },
  { label: 'Mutual Aid', href: '/dashboard/mutual-aid', icon: LifeBuoy },
  { label: 'Contractor Network', href: '/dashboard/network', icon: Network },
  { label: 'Emergency Network', href: '/dashboard/emergency-network', icon: Siren },
  { label: 'Job Handoffs', href: '/dashboard/network/handoffs', icon: ArrowRightLeft },
  { label: 'Open Job Board', href: '/dashboard/job-board', icon: ClipboardList },
  { label: 'Home Demand Exchange', href: '/dashboard/demand-exchange', icon: Radar, requiresPermission: 'can_view_billing' },
  { label: 'Capacity Exchange', href: '/dashboard/network/capacity-exchange', icon: Shuffle },
  { label: 'Skill Market', href: '/dashboard/network/skill-market', icon: Globe2 },
  { label: 'Insurance Claims', href: '/dashboard/insurance-claims', icon: ShieldAlert },
  { label: 'Risk Intelligence', href: '/dashboard/risk-intelligence', icon: Gauge },
  { label: 'Compliance Center', href: '/dashboard/compliance', icon: ShieldCheck },
  { label: 'Refrigerant Leaks', href: '/dashboard/refrigerant-leaks', icon: Snowflake },
  { label: 'Permit Center', href: '/dashboard/permits', icon: ClipboardCheck },
  { label: 'Documents', href: '/dashboard/documents', icon: FolderLock },
  { label: 'Gallery', href: '/dashboard/gallery', icon: Images },
  { label: 'Callback Root-Cause', href: '/dashboard/callback-root-cause', icon: Microscope },
  { label: 'AI Job Autopsy', href: '/dashboard/job-autopsy', icon: Stethoscope },
  { label: 'Autonomy Readiness', href: '/dashboard/autonomy-readiness', icon: Gauge },
  { label: 'Accounting', href: '/dashboard/accounting', icon: BookOpen },
  { label: 'Budgets', href: '/dashboard/budgets', icon: Wallet, requiresPermission: 'can_view_billing' },
  { label: 'Per Diem', href: '/dashboard/per-diem', icon: Route },
  { label: 'Location Privacy', href: '/dashboard/location-privacy', icon: ShieldCheck, requiresPermission: 'can_manage_team' },
  { label: 'Site Safety', href: '/dashboard/site-safety', icon: ShieldCheck, requiresPermission: 'can_manage_team' },
  { label: 'Talent Network', href: '/dashboard/talent', icon: Briefcase, requiresPermission: 'can_manage_team' },
  { label: 'Prevailing Wage', href: '/dashboard/prevailing-wage', icon: Scale, requiresPermission: 'can_view_billing' },
  { label: 'Refunds', href: '/dashboard/refunds', icon: Undo2, requiresPermission: 'can_view_billing' },
  { label: 'Chart of Accounts', href: '/dashboard/chart-of-accounts', icon: Layers, requiresPermission: 'can_view_billing' },
  { label: 'Multi-Entity Reporting', href: '/dashboard/multi-entity-reporting', icon: Network, requiresPermission: 'can_view_billing' },
  { label: 'Fixed Assets', href: '/dashboard/fixed-assets', icon: Warehouse, requiresPermission: 'can_view_billing' },
  { label: 'Multi-Entity Accounting', href: '/dashboard/multi-entity', icon: Network, requiresPermission: 'can_view_billing' },
  { label: 'Fixed Assets', href: '/dashboard/fixed-assets', icon: Package, requiresPermission: 'can_view_billing' },
  { label: 'Bank Intelligence', href: '/dashboard/bank-intelligence', icon: Landmark },
  { label: 'Payroll', href: '/dashboard/payroll', icon: DollarSign },
  { label: 'Vireek Pay', href: '/dashboard/pay', icon: CreditCard, requiresPermission: 'can_view_billing' },
  { label: 'Tax Center', href: '/dashboard/tax', icon: Receipt, requiresPermission: 'can_view_billing' },
  { label: 'Expenses', href: '/dashboard/expenses', icon: Receipt },
  { label: 'Commissions', href: '/dashboard/commissions', icon: Coins, requiresPermission: 'can_view_billing' },
  { label: 'Payroll Sync', href: '/dashboard/payroll-sync', icon: Plug, requiresPermission: 'can_view_billing' },
  { label: 'Payroll Connectors', href: '/dashboard/payroll-connectors', icon: ArrowRightLeft, requiresPermission: 'can_view_billing' },
  { label: 'Job Quality Gate', href: '/dashboard/job-quality-gate', icon: ClipboardCheck },
  { label: 'Job Statuses', href: '/dashboard/settings/statuses', icon: ListChecks },
  { label: 'Job Statuses', href: '/dashboard/settings/statuses', icon: ListChecks },
  { label: 'Evidence Chain', href: '/dashboard/evidence-chain', icon: Link2 },
  { label: 'Warranty Claim Recovery', href: '/dashboard/warranty-claims', icon: FileClock },
  { label: 'Install Closeout', href: '/dashboard/install-closeout', icon: ClipboardCheck, requiresPermission: 'can_view_all_jobs' },
  { label: 'Protection Plans', href: '/dashboard/protection-plans', icon: ShieldCheck, requiresPermission: 'can_view_billing' },
  { label: 'Business Immune System', href: '/dashboard/immune-system', icon: Siren },
  { label: 'Compounding Flywheel', href: '/dashboard/flywheel', icon: RefreshCw },
  { label: 'Adaptive Diagnostic', href: '/dashboard/adaptive-diagnostics', icon: Stethoscope },
  { label: 'Predictive Failure', href: '/dashboard/predictive-failure', icon: Radar },
  { label: 'Preventive Maintenance', href: '/dashboard/preventive-maintenance', icon: CalendarClock, requiresPermission: 'can_view_all_jobs' },
  { label: 'Verification Network', href: '/dashboard/verification-network', icon: BadgeCheck },
  { label: 'Physical Economy Network', href: '/dashboard/physical-economy-network', icon: Network },
  { label: 'Service Recovery', href: '/dashboard/service-recovery', icon: HeartHandshake },
  { label: 'Surveys', href: '/dashboard/surveys', icon: MessageSquareHeart, requiresPermission: 'can_view_billing' },
  { label: 'Self-Healing', href: '/dashboard/self-healing', icon: HeartPulse },
  { label: 'Regulation Graph', href: '/dashboard/regulation-graph', icon: Landmark },
  { label: 'Permit Intelligence', href: '/dashboard/permit-intelligence', icon: ClipboardCheck },
  { label: 'Switching Shield', href: '/dashboard/switching-shield', icon: UserMinus },
  { label: 'Labor Marketplace', href: '/dashboard/labor-marketplace', icon: HandHelping },
  { label: 'Commercial Contracts', href: '/dashboard/contracts', icon: FileSignature },
  { label: 'Work Orders', href: '/dashboard/work-orders', icon: ClipboardList, requiresPermission: 'can_view_billing' },
  { label: 'Contract Intelligence', href: '/dashboard/contract-intelligence', icon: FileSearch },
  { label: 'Service Agreements', href: '/dashboard/agreements', icon: FileCheck2, requiresPermission: 'can_view_billing' },
  { label: 'Reviews', href: '/dashboard/reviews', icon: Star },
  { label: 'Customer Feedback', href: '/dashboard/feedback-analytics', icon: Smile, requiresPermission: 'can_view_all_jobs' },
  { label: 'Weekly Scorecard', href: '/dashboard/weekly-scorecard', icon: Smile, requiresPermission: 'can_view_all_jobs' },
  { label: 'Promise Tracker', href: '/dashboard/promises', icon: Handshake },
  { label: 'Conversation Intelligence', href: '/dashboard/conversations', icon: MessagesSquare },
  { label: 'Service Recovery', href: '/dashboard/service-recovery', icon: MessageSquareWarning },
  { label: 'Memberships', href: '/dashboard/memberships', icon: Award },
  { label: 'Renewals', href: '/dashboard/memberships/renewals', icon: RotateCcw, requiresPermission: 'can_view_billing' },
  { label: 'Gift Cards', href: '/dashboard/gift-cards', icon: Gift, requiresPermission: 'can_view_billing' },
  { label: 'Loyalty Points', href: '/dashboard/loyalty', icon: Award, requiresPermission: 'can_view_billing' },
  { label: 'Wallet Passes', href: '/dashboard/wallet-passes', icon: Wallet },
  { label: 'Recurring Jobs', href: '/dashboard/recurring-jobs', icon: Repeat, requiresPermission: 'can_view_billing' },
  { label: 'Trade Packs', href: '/dashboard/trade-packs', icon: PackageCheck, requiresPermission: 'can_edit_business_profile' },
  { label: 'Landscaping', href: '/dashboard/landscaping', icon: Leaf, requiresPermission: 'can_view_all_jobs', gate: 'landscaping' },
  { label: 'Pest Ops', href: '/dashboard/pest-ops', icon: Bug, hiddenUnless: 'pest_ops' },
  { label: 'Commercial', href: '/dashboard/commercial', icon: PackageCheck, requiresPermission: 'can_view_billing', requiresFlag: 'commercial_pack' },
  { label: 'My Day (Field)', href: '/tech/today', icon: Wrench },
  { label: 'Weekly Schedule (Field)', href: '/tech/schedule', icon: Calendar },
  { label: 'Expert Assist', href: '/dashboard/expert-assist', icon: LifeBuoy },
  { label: 'Video Sessions', href: '/dashboard/video-sessions', icon: Video },
  { label: 'Field Messages', href: '/dashboard/field-messages', icon: MessageSquare },
  { label: 'Price Book', href: '/dashboard/price-book', icon: DollarSign },
  { label: 'AI Takeoff', href: '/dashboard/takeoff', icon: Ruler },
  { label: 'Price Lists', href: '/dashboard/price-lists', icon: Tags, requiresPermission: 'can_view_billing' },
  { label: 'Form Builder', href: '/dashboard/form-builder', icon: ClipboardList, requiresPermission: 'can_edit_business_profile' },
  { label: 'Job Templates', href: '/dashboard/job-templates', icon: LayoutTemplate, requiresPermission: 'can_view_billing' },
  { label: 'SOP Library', href: '/dashboard/sop-library', icon: BookOpenCheck, requiresPermission: 'can_manage_team' },
  { label: 'Safety Data Sheets', href: '/safety/sds', icon: FlaskConical },
  { label: 'SOP Training', href: '/dashboard/training', icon: GraduationCap },
  { label: 'Service Catalog', href: '/dashboard/service-catalog', icon: ClipboardList, requiresPermission: 'can_view_billing' },
  { label: 'Underpriced Jobs', href: '/dashboard/underpriced-jobs', icon: TrendingDown, requiresPermission: 'can_view_billing' },
  { label: 'Equipment Health', href: '/dashboard/equipment-health', icon: HeartPulse },
  { label: 'Equipment Passports', href: '/dashboard/equipment-passports', icon: QrCode },
  { label: 'Vireek Tags', href: '/dashboard/tags', icon: QrCode },
  { label: 'Home Passports', href: '/dashboard/home-passports', icon: Home },
  { label: 'OEM Intelligence', href: '/dashboard/oem-intelligence', icon: Factory },
  { label: 'OEM Intelligence Graph', href: '/dashboard/oem-graph', icon: Network },
  { label: 'Recall Center', href: '/dashboard/recalls', icon: ShieldAlert, requiresPermission: 'can_view_all_jobs' },
  { label: 'Universal Identity', href: '/dashboard/identity-graph', icon: Fingerprint },
  { label: 'Field Intelligence', href: '/dashboard/field-intelligence', icon: Satellite },
  { label: 'Home Health', href: '/dashboard/home-health', icon: Activity },
  { label: 'Home Service Passport', href: '/dashboard/home-passport', icon: ShieldCheck, requiresPermission: 'can_view_billing' },
  { label: 'Home Passport Pilot', href: '/dashboard/home-passport/pilot', icon: ShieldCheck, requiresPermission: 'can_view_billing', requiresFlag: 'home_passport_pilot' },
  { label: 'Property Intelligence', href: '/dashboard/property-intelligence', icon: Radar },
  { label: 'Fleet Economics', href: '/dashboard/fleet-economics', icon: Fuel },
  { label: 'Telematics OS', href: '/dashboard/telematics', icon: Satellite },
  { label: 'Live Map', href: '/dashboard/live-map', icon: Navigation, requiresPermission: 'can_view_all_jobs' },
  { label: 'Fleet Intelligence', href: '/dashboard/fleet-intelligence', icon: Radar },
  { label: 'Vehicles', href: '/dashboard/vehicles', icon: Truck, requiresPermission: 'can_manage_team' },
  { label: 'Vehicle Inspections (DVIR)', href: '/dashboard/fleet-dvir', icon: ClipboardCheck },
  { label: 'Fuel Cards', href: '/dashboard/fuel-cards', icon: CreditCard, requiresPermission: 'can_manage_team' },
  { label: 'Card Purchases', href: '/dashboard/card-feed', icon: CreditCard },
  { label: 'Field Evidence', href: '/dashboard/field-evidence', icon: ScanEye },
  { label: 'Property Vision', href: '/dashboard/property-vision', icon: ScanEye },
  { label: 'Customer Trust Bank', href: '/dashboard/trust-bank', icon: ShieldCheck },
  { label: 'Next Best Actions', href: '/dashboard/next-best-actions', icon: Target },
  { label: 'Call Queue', href: '/dashboard/call-queue', icon: PhoneCall },
  { label: 'Rescue Loop', href: '/dashboard/rescue-loop', icon: Timer },
  { label: 'Diagnosis Copilot', href: '/dashboard/diagnosis-copilot', icon: Stethoscope },
  { label: 'Remote Resolution', href: '/dashboard/remote-resolution', icon: PhoneCall },
  { label: 'Service Intelligence Loop', href: '/dashboard/service-intelligence-loop', icon: Network },
  { label: 'Duration Intelligence', href: '/dashboard/duration-intelligence', icon: Gauge },
  { label: 'Failure Genome', href: '/dashboard/failure-genome', icon: Dna },
  { label: 'Adaptive Diagnostics', href: '/dashboard/adaptive-diagnostics', icon: Stethoscope },
  { label: 'Live Copilot', href: '/dashboard/live-copilot', icon: Radio },
  { label: 'Margin Guardrails', href: '/dashboard/margin-guardrails', icon: ShieldCheck, requiresPermission: 'can_view_billing' },
  { label: 'Promo Codes', href: '/dashboard/promo-codes', icon: TicketPercent, requiresPermission: 'can_view_billing' },
  { label: 'Quote Truth Engine', href: '/dashboard/quote-truth', icon: Scale, requiresPermission: 'can_view_billing' },
  { label: 'Operational Truth', href: '/dashboard/operational-truth', icon: ShieldCheck },
  { label: 'Incentive Engine', href: '/dashboard/incentives', icon: BadgePercent, requiresPermission: 'can_view_billing' },
  { label: 'Rebate Intelligence', href: '/dashboard/rebate-intelligence', icon: PiggyBank },
  { label: 'Install Closeout', href: '/dashboard/closeout', icon: ClipboardCheck },
  { label: 'Repair vs Replace', href: '/dashboard/repair-replace', icon: Scale },
  { label: 'Energy Intelligence', href: '/dashboard/energy-intelligence', icon: Zap },
  { label: 'Automation Marketplace', href: '/dashboard/automation-marketplace', icon: Zap },
  { label: 'Company Reflexes', href: '/dashboard/reflexes', icon: Zap },
  { label: 'Workflows', href: '/dashboard/workflows', icon: Workflow },
  { label: 'Workflow Compiler', href: '/dashboard/workflow-compiler', icon: GitMerge },
  { label: 'Franchise Command Center', href: '/dashboard/franchise', icon: Building2 },
  { label: 'Franchise Governance', href: '/dashboard/franchise/governance', icon: Gavel },
  { label: 'Event Bus', href: '/dashboard/event-bus', icon: Webhook },
  { label: 'Event Prediction Mesh', href: '/dashboard/event-prediction-mesh', icon: Radar },
  { label: 'Reliability & Observability', href: '/dashboard/reliability', icon: Activity },
  { label: 'Activity Ledger', href: '/dashboard/activity-ledger', icon: History },
  { label: 'Workflow Health', href: '/dashboard/workflow-health', icon: ShieldAlert },
  { label: 'Technician Capacity', href: '/dashboard/technician-capacity', icon: Lock },
  { label: 'Capacity Demand Control', href: '/dashboard/capacity-demand', icon: Gauge },
  { label: 'Capacity Guard', href: '/dashboard/capacity-guard', icon: ShieldCheck },
  { label: 'Staffing Forecast', href: '/dashboard/staffing-forecast', icon: CalendarClock },
  { label: 'Seasonal Revenue Stabilizer', href: '/dashboard/seasonal-stabilizer', icon: CalendarClock },
  { label: 'Workforce Equilibrium', href: '/dashboard/workforce-equilibrium', icon: Scale },
  { label: 'Retention Engine', href: '/dashboard/technician-retention', icon: HeartHandshake, requiresPermission: 'can_manage_team' },
  { label: 'Business Drift Detector', href: '/dashboard/business-drift', icon: Compass },
  { label: 'Executive Reports', href: '/dashboard/reports/executive', icon: FileBarChart, ownerOnly: true },
  { label: 'Valuation', href: '/valuation', icon: ValuationIcon, ownerOnly: true },
  { label: 'Exit Readiness', href: '/dashboard/exit-readiness', icon: Gauge, ownerOnly: true },
  { label: 'Opportunity Cost Ledger', href: '/dashboard/opportunity-cost', icon: Hourglass },
  { label: 'Causal Shock Simulator', href: '/dashboard/causal-shock-simulator', icon: Waves },
  { label: 'Technician Performance', href: '/dashboard/technician-performance', icon: Gauge, requiresPermission: 'can_view_billing' },
  { label: 'Lead Marketplaces', href: '/dashboard/lead-marketplaces', icon: Target, requiresPermission: 'can_view_billing' },
  { label: 'Third-Party Intake', href: '/dashboard/third-party-intake', icon: Inbox, requiresPermission: 'can_view_billing' },
  { label: 'Click-to-Cash', href: '/dashboard/click-to-cash', icon: MousePointerClick, requiresPermission: 'can_view_billing' },
  { label: 'Demand OS', href: '/dashboard/demand-os', icon: Megaphone, requiresPermission: 'can_view_billing' },
  { label: 'Skill Graph', href: '/dashboard/skill-graph', icon: GitBranch, requiresPermission: 'can_view_billing' },
  { label: 'Trust Passport', href: '/dashboard/trust-passport', icon: Fingerprint, requiresPermission: 'can_view_billing' },
  { label: 'Technician Identity Graph', href: '/dashboard/technician-identity', icon: Network },
  { label: 'Technician Simulator', href: '/dashboard/technician-simulator', icon: FlaskConical },
  { label: 'Apprenticeship Engine', href: '/dashboard/apprenticeship', icon: GraduationCap },
  { label: 'Adoption OS', href: '/dashboard/adoption', icon: Activity },
  { label: 'First-Time-Fix Autopilot', href: '/dashboard/first-time-fix', icon: Crosshair },
  { label: 'Resolution Probability', href: '/dashboard/resolution-probability', icon: Target },
  { label: 'Experimentation', href: '/dashboard/experiments', icon: Beaker, requiresPermission: 'can_view_billing' },
  { label: 'Weather Surge', href: '/dashboard/weather-surge', icon: CloudLightning },
  { label: 'Emergency Operations', href: '/dashboard/emergency-ops', icon: Siren },
  { label: 'Profitability', href: '/dashboard/profitability', icon: Calculator, requiresPermission: 'can_view_billing' },
  { label: 'Knowledge', href: '/dashboard/knowledge', icon: BookOpen },
  { label: 'Knowledge Capture', href: '/dashboard/knowledge-capture', icon: BookMarked },
  { label: 'Revenue Protection', href: '/dashboard/revenue-protection', icon: ShieldCheck, requiresPermission: 'can_view_billing' },
  { label: 'Recovery Ledger', href: '/dashboard/recovery', icon: TrendingUp, requiresPermission: 'can_view_billing' },
  { label: 'Money Recovered', href: '/dashboard/recovery/statements', icon: Receipt, requiresPermission: 'can_view_billing' },
  { label: 'Results', href: '/dashboard/results', icon: Medal, requiresPermission: 'can_view_billing' },
  { label: 'Results Plan', href: '/dashboard/results-plan', icon: Receipt, requiresPermission: 'can_view_billing' },
  { label: 'Pilot Results', href: '/dashboard/pilot-results', icon: Medal, requiresPermission: 'can_view_billing' },
  { label: 'Pilot Results', href: '/dashboard/pilot-results', icon: Receipt, requiresPermission: 'can_view_billing' },
  { label: 'Benchmarks', href: '/dashboard/benchmarks', icon: BarChart3, requiresPermission: 'can_view_billing' },
  { label: 'Outcome Benchmarks', href: '/dashboard/outcome-benchmarks', icon: BarChart3, requiresPermission: 'can_view_billing' },
  { label: 'Insights', href: '/dashboard/insights', icon: TrendingUp, requiresPermission: 'can_view_billing' },
  { label: 'Data Exchange', href: '/dashboard/data-exchange', icon: Handshake, requiresPermission: 'can_view_billing' },
  { label: 'Supplier Audit', href: '/dashboard/supplier-audit', icon: SearchCheck, requiresPermission: 'can_view_billing' },
  { label: 'Global Failure Atlas', href: '/dashboard/failure-atlas', icon: Globe },
  { label: 'Business Contradictions', href: '/dashboard/contradictions', icon: AlertOctagon },
  { label: 'Counterfactual Library', href: '/dashboard/counterfactuals', icon: GitBranch },
  { label: 'Organizational Memory', href: '/dashboard/org-memory', icon: Library },
  { label: 'Causal ROI Attribution', href: '/dashboard/causal-roi', icon: FlaskConical },
  { label: 'Counterfactual Reality Engine', href: '/dashboard/reality-engine', icon: Route },
  { label: 'Causal Disruption Chains', href: '/dashboard/causal-chains', icon: Workflow },
  { label: 'Revenue Causality Graph', href: '/dashboard/revenue-causality', icon: Network, requiresPermission: 'can_view_billing' },
  { label: 'Invoicing', href: '/dashboard/invoicing', icon: Receipt, requiresPermission: 'can_view_billing' },
  { label: 'Sales Tax', href: '/dashboard/tax', icon: Percent, requiresPermission: 'can_view_billing' },
  { label: 'Receivables Intelligence', href: '/dashboard/receivables', icon: Landmark, requiresPermission: 'can_view_billing' },
  { label: 'Revenue Radar', href: '/dashboard/revenue-radar', icon: Radar, requiresPermission: 'can_view_billing' },
  { label: 'Collections', href: '/dashboard/collections', icon: PhoneCall, requiresPermission: 'can_view_billing' },
  { label: 'Customer Statements', href: '/dashboard/statements', icon: ScrollText, requiresPermission: 'can_view_billing' },
  { label: 'Community', href: '/dashboard/community', icon: MessageCircle },
  { label: 'Feedback', href: '/dashboard/feedback', icon: Lightbulb },
  { label: 'Negative Knowledge Store', href: '/dashboard/negative-knowledge', icon: History },
  { label: 'Commitment Graph', href: '/dashboard/commitments', icon: ShieldCheck },
  { label: 'Evolution Roadmap', href: '/dashboard/roadmap', icon: Compass, requiresPermission: 'can_view_billing' },
  { label: 'Business Constitution', href: '/dashboard/constitution', icon: Scale },
  { label: 'Market Intelligence', href: '/dashboard/market-intelligence', icon: Network },
  { label: 'Identity Learner', href: '/dashboard/identity', icon: Fingerprint, requiresPermission: 'can_view_billing' },
  { label: 'Governance Center', href: '/dashboard/governance', icon: ShieldAlert },
  { label: 'Trust Pack', href: '/dashboard/trust-pack', icon: ShieldCheck, requiresPermission: 'can_manage_security' },
  { label: 'Value at Risk', href: '/dashboard/value-at-risk', icon: Radar, requiresPermission: 'can_view_billing' },
  { label: 'Revenue Autopsy', href: '/dashboard/revenue-autopsy', icon: Skull, requiresPermission: 'can_view_billing' },
  { label: 'LTV Autopilot', href: '/dashboard/ltv-autopilot', icon: Rocket, requiresPermission: 'can_view_billing' },
  { label: 'Bottleneck Market Maker', href: '/dashboard/bottleneck-market', icon: Crosshair, requiresPermission: 'can_view_billing' },
  { label: 'Uncertainty & Evidence Map', href: '/dashboard/uncertainty-map', icon: Fingerprint, requiresPermission: 'can_view_billing' },
  { label: 'Unknowns Engine', href: '/dashboard/unknowns', icon: Telescope, requiresPermission: 'can_view_billing' },
  { label: 'Playbooks', href: '/dashboard/playbooks', icon: BookMarked, requiresPermission: 'can_edit_business_profile' },
  { label: 'Playbook Library', href: '/dashboard/playbook-library', icon: BookMarked, requiresPermission: 'can_edit_business_profile' },
  { label: 'Templates', href: '/dashboard/templates', icon: MessageSquareText, requiresPermission: 'can_edit_business_profile' },
  { label: 'Document Templates', href: '/dashboard/document-templates', icon: ScrollText, requiresPermission: 'can_edit_business_profile' },
  { label: 'Local Rank Grid', href: '/dashboard/geo-grid', icon: MapPin, requiresPermission: 'can_edit_business_profile' },
  { label: 'Trade Playbooks', href: '/dashboard/trade-playbooks', icon: ClipboardCheck, requiresPermission: 'can_edit_business_profile' },
  { label: 'Agent Governance', href: '/dashboard/agent-governance', icon: ShieldCheck, requiresPermission: 'can_manage_security' },
  { label: 'Agent Actions', href: '/dashboard/agent-actions', icon: MousePointerClick, requiresPermission: 'can_manage_security', requiresFlag: 'agent_action_framework' },
  { label: 'AI Security Center', href: '/dashboard/security-center', icon: LockKeyhole, requiresPermission: 'can_manage_security' },
  { label: 'AI Reliability', href: '/dashboard/ai-reliability', icon: ShieldCheck, requiresPermission: 'can_manage_security' },
  { label: 'AI Transparency', href: '/dashboard/ai-transparency', icon: Fingerprint, requiresPermission: 'can_manage_security' },
  { label: 'Multi-Agent Company', href: '/dashboard/agent-company', icon: Users2, requiresPermission: 'can_manage_security' },
  { label: 'Agent Network', href: '/dashboard/agent-network', icon: Network, requiresPermission: 'can_manage_security' },
  { label: 'Evaluation Plane', href: '/dashboard/evaluation-plane', icon: Microscope, requiresPermission: 'can_view_billing' },
  { label: 'Agent Marketplace', href: '/dashboard/agent-marketplace', icon: Store },
  { label: 'Autonomy Budget', href: '/dashboard/autonomy-budget', icon: Timer, requiresPermission: 'can_manage_security' },
  { label: 'Execution Reliability', href: '/dashboard/execution-reliability', icon: Gauge, requiresPermission: 'can_view_billing' },
  { label: 'Vendor & Procurement', href: '/dashboard/procurement', icon: Truck, requiresPermission: 'can_view_billing' },
  { label: 'Vendor Management', href: '/dashboard/vendors', icon: Building2, requiresPermission: 'can_view_billing' },
  { label: 'Supplier Catalog', href: '/dashboard/supplier-catalog', icon: Package, requiresPermission: 'can_view_billing' },
  { label: 'Supplier PunchOut', href: '/dashboard/supplier-punchout', icon: Handshake, requiresPermission: 'can_view_billing' },
  { label: 'AI Parts Market', href: '/dashboard/parts-market', icon: Store, requiresPermission: 'can_view_billing' },
  { label: 'Parts Intelligence', href: '/dashboard/parts-intelligence', icon: PackageSearch, requiresPermission: 'can_view_billing' },
  { label: 'Supplier Intelligence', href: '/dashboard/supplier-intelligence', icon: Handshake, requiresPermission: 'can_view_billing' },
  { label: 'Procurement Network', href: '/dashboard/procurement-network', icon: Handshake, requiresPermission: 'can_view_billing' },
  { label: 'Supply Chain Outcomes', href: '/dashboard/supply-chain-outcomes', icon: GitBranch, requiresPermission: 'can_view_billing' },
  { label: 'Outcome Assurance', href: '/dashboard/outcome-assurance', icon: ShieldCheck, requiresPermission: 'can_view_billing' },
  { label: 'Outcome Intelligence Network', href: '/dashboard/outcome-network', icon: Network },
  { label: 'Outcome Clearinghouse', href: '/dashboard/outcome-clearinghouse', icon: Scale },
  { label: 'Truck-Roll Elimination', href: '/dashboard/truck-roll', icon: Ban, requiresPermission: 'can_view_billing' },
  { label: 'Evidence Marketplace', href: '/dashboard/evidence-marketplace', icon: Network, requiresPermission: 'can_manage_security' },
  { label: 'Verified Service', href: '/dashboard/service-guarantee', icon: ShieldCheck, requiresPermission: 'can_view_billing' },
  { label: 'Continuous Improvement', href: '/dashboard/continuous-improvement', icon: RefreshCw, requiresPermission: 'can_view_billing' },
  { label: 'Learning Compiler', href: '/dashboard/learning-compiler', icon: Workflow, requiresPermission: 'can_view_billing' },
  { label: 'Operations Sandbox', href: '/dashboard/operations-sandbox', icon: FlaskConical, requiresPermission: 'can_view_billing' },
  { label: 'Operations Loop', href: '/dashboard/operations-loop', icon: InfinityIcon, requiresPermission: 'can_view_billing' },
  { label: 'Pricing Flywheel', href: '/dashboard/pricing-flywheel', icon: TrendingUp, requiresPermission: 'can_view_billing' },
];


export const ACCOUNT_ITEMS: NavItem[] = [
  { label: 'My Account', href: '/dashboard/account', icon: User },
  { label: 'Business Profile', href: '/dashboard/business-profile', icon: Settings, requiresPermission: 'can_edit_business_profile' },
  { label: 'Branding', href: '/dashboard/settings/branding', icon: Paintbrush, requiresPermission: 'can_edit_business_profile' },
  { label: 'Booking Settings', href: '/dashboard/booking-settings', icon: CalendarClock, requiresPermission: 'can_edit_business_profile' },
  { label: 'Dashboard Builder', href: '/dashboard/dashboard-builder', icon: LayoutDashboard, requiresPermission: 'can_manage_team' },
  { label: 'Payment Pricing', href: '/dashboard/payment-pricing', icon: BadgePercent, requiresPermission: 'can_edit_business_profile' },
  { label: 'Google Booking', href: '/dashboard/google-booking', icon: Globe, requiresPermission: 'can_edit_business_profile' },
  { label: 'Agent Readiness', href: '/dashboard/agent-readiness', icon: Radar, requiresPermission: 'can_edit_business_profile' },
  { label: 'AI Agent Requests', href: '/dashboard/consumer-agent', icon: MessageSquareText, requiresPermission: 'can_manage_team' },
  { label: 'Locations', href: '/dashboard/settings/locations', icon: Building2, requiresPermission: 'can_edit_business_profile' },
  { label: 'Acquisitions', href: '/dashboard/acquisitions', icon: Building2, requiresPermission: 'can_edit_business_profile' },
  { label: 'Regional Packs', href: '/dashboard/settings/regional-packs', icon: Globe, requiresPermission: 'can_edit_business_profile' },
  { label: 'Team', href: '/dashboard/team', icon: ShieldCheck, requiresPermission: 'can_manage_team' },
  { label: 'Org Chart', href: '/dashboard/team/org-chart', icon: Network },
  { label: 'Time Off', href: '/dashboard/time-off', icon: CalendarOff, requiresPermission: 'can_manage_team' },
  { label: 'HR & Onboarding', href: '/dashboard/hr', icon: ClipboardList, ownerOnly: true },
  { label: 'Billing', href: '/dashboard/billing', icon: CreditCard, requiresPermission: 'can_view_billing' },
  { label: 'Slack & Teams', href: '/dashboard/settings/slack-teams', icon: MessageSquareWarning, requiresPermission: 'can_manage_team' },
  { label: 'Billing Invoices', href: '/dashboard/billing/invoices', icon: Receipt, requiresPermission: 'can_view_billing' },
  { label: 'Plans & Upgrades', href: '/dashboard/billing/plans', icon: Rocket, requiresPermission: 'can_view_billing' },
  { label: 'Payments', href: '/dashboard/payments', icon: CreditCard, requiresPermission: 'can_view_billing' },
  { label: 'Payment Plans', href: '/dashboard/payment-plans', icon: Calendar, requiresPermission: 'can_view_billing' },
  { label: 'Pay by Bank', href: '/dashboard/pay-by-bank', icon: Banknote, requiresPermission: 'can_view_billing' },
  { label: 'Disputes', href: '/dashboard/disputes', icon: ShieldAlert, requiresPermission: 'can_view_billing' },
  { label: 'Financing Center', href: '/dashboard/financing', icon: Landmark, requiresPermission: 'can_view_billing' },
  { label: 'Partner Financing', href: '/dashboard/financing/partners', icon: Landmark, requiresPermission: 'can_view_billing' },
  { label: 'Benchmarks', href: '/dashboard/benchmarks', icon: TrendingUp, requiresPermission: 'can_view_billing' },
  { label: 'Hours Audit', href: '/dashboard/hours-audit', icon: Timer, requiresPermission: 'can_view_billing' },
  { label: 'Hidden Technician', href: '/dashboard/hidden-technician', icon: Timer, requiresPermission: 'can_view_billing' },
  { label: 'Integrations', href: '/dashboard/integrations', icon: Plug },
  { label: 'Accounting Sync', href: '/dashboard/accounting', icon: Calculator, requiresPermission: 'can_view_billing' },
  { label: 'Data Imports', href: '/dashboard/imports', icon: FileUp, requiresPermission: 'can_edit_business_profile' },
  { label: 'Phone Payments', href: '/dashboard/phone-payments', icon: ShieldCheck, requiresPermission: 'can_view_billing' },
  { label: 'CRM Sync', href: '/dashboard/crm-sync', icon: Workflow, requiresPermission: 'can_edit_business_profile' },
  { label: 'NetSuite', href: '/dashboard/netsuite', icon: Building2, requiresPermission: 'can_edit_business_profile' },
  { label: 'Sage Intacct', href: '/dashboard/sage-intacct', icon: Workflow, requiresPermission: 'can_edit_business_profile' },
  { label: 'Xero', href: '/dashboard/xero', icon: Calculator },
  { label: 'Property Management', href: '/dashboard/property-management', icon: Building2, requiresPermission: 'can_edit_business_profile' },
  { label: 'Custom Fields', href: '/dashboard/custom-fields', icon: SlidersHorizontal, requiresPermission: 'can_edit_business_profile' },
  { label: 'Exports', href: '/dashboard/exports', icon: FolderDown, requiresPermission: 'can_export_data' },
  { label: 'BI Export', href: '/dashboard/bi-export', icon: BarChart3, requiresPermission: 'can_export_data' },
  { label: 'Data Platform', href: '/dashboard/data-platform', icon: Database, requiresPermission: 'can_export_data' },
  { label: 'BI Connectors', href: '/dashboard/bi-connectors', icon: PlugZap, requiresPermission: 'can_export_data' },
  { label: 'BI Connectors', href: '/dashboard/bi-connectors', icon: PlugZap, requiresPermission: 'can_export_data' },
  { label: 'Duplicates', href: '/dashboard/duplicates', icon: GitMerge, requiresPermission: 'can_view_billing' },
  { label: 'Compliance Rules', href: '/dashboard/compliance-rules', icon: Scale, requiresPermission: 'can_edit_business_profile' },
  { label: 'Fair Sale', href: '/dashboard/fair-sale', icon: Scale, requiresPermission: 'can_edit_business_profile' },
  { label: 'Trash', href: '/dashboard/trash', icon: Trash2, requiresPermission: 'can_view_billing' },
  { label: 'API Usage', href: '/dashboard/settings/api-usage', icon: Activity },
  { label: 'Webhook Deliveries', href: '/dashboard/webhook-deliveries', icon: PlugZap, ownerOnly: true, flag: 'public_api_v2' },
  { label: 'Email Settings', href: '/dashboard/settings/email', icon: Mail, requiresPermission: 'can_edit_business_profile' },
  { label: 'Settings', href: '/dashboard/settings', icon: Settings },
  { label: 'Settings Center', href: '/dashboard/settings/center', icon: SlidersHorizontal },
  { label: 'Chat Widget', href: '/dashboard/settings/chat-widget', icon: MessageCircle, requiresPermission: 'can_edit_business_profile' },
  { label: 'Website Widgets', href: '/dashboard/settings/website-widgets', icon: Globe, requiresPermission: 'can_edit_business_profile' },
  { label: 'Trust Badge', href: '/dashboard/settings/trust-badge', icon: Globe, requiresPermission: 'can_edit_business_profile' },
  { label: 'Call Tracking', href: '/dashboard/settings/call-tracking', icon: PhoneCall, requiresPermission: 'can_edit_business_profile' },
  { label: 'What’s New', href: '/dashboard/whats-new', icon: FileClock },
  { label: 'Help', href: '/dashboard/help', icon: LifeBuoy },
];

type NavGates = Partial<Record<'landscaping', boolean>>;
const NO_MODULES: ReadonlySet<string> = new Set();
const PILLAR_ICONS: Record<PillarId, typeof LayoutDashboard> = {
  answer: PhoneCall,
  dispatch: Calendar,
  grow: TrendingUp,
  settings: Settings,
  labs: FlaskConical,
};

/** Always-visible entry to the global command palette (⌘K / Ctrl K). */
function SidebarSearchButton() {
  const { t } = useTranslation('dashboard');
  const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  return (
    <button
      type="button"
      onClick={() => openPalette()}
      className="focus-ring flex w-full items-center gap-2 rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-[13px] text-text-secondary transition-colors hover:text-text-primary"
    >
      <Icon icon={Search} size="sm" className="text-text-muted" />
      <span className="flex-1 text-start">{t('nav.search', { defaultValue: 'Search' })}</span>
      <kbd className="rounded border border-border px-1.5 text-[11px] font-medium text-text-muted">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
    </button>
  );
}

const MENU_ITEM =
  'focus-ring flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-start text-[13px] text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary';

/**
 * Account switcher at the foot of the sidebar: who is signed in, appearance, account links, sign out.
 * Disclosure pattern (button + panel), not role="menu": the panel holds a radio group (theme) next to links,
 * which a menu role cannot contain. Closes on Escape (focus returns to the trigger), outside pointer and focus leaving.
 */
function AccountMenu({
  email,
  displayName,
  roleLabel,
  onNavigate,
  onShortcuts,
  onAccessibility,
  onSignOut,
}: {
  email: string;
  displayName?: string;
  roleLabel: string;
  onNavigate: () => void;
  onShortcuts: () => void;
  onAccessibility: () => void;
  onSignOut: () => void;
}) {
  const { t } = useTranslation('dashboard');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const themeLabelId = `${panelId}-theme`;
  const name = displayName?.trim() || email || t('nav.account.fallback', { defaultValue: 'Account' });
  const initial = (name.trim()[0] ?? 'V').toUpperCase();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && !rootRef.current?.contains(next)) setOpen(false);
      }}
    >
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label={t('nav.account.label', { defaultValue: 'Account' })}
          className="absolute inset-x-0 bottom-full mb-1.5 rounded-xl border border-border bg-bg-secondary p-1.5 shadow-elevation-3"
        >
          <div className="px-2.5 pb-2 pt-1.5">
            <p className="truncate text-[13px] font-medium text-text-primary">{name}</p>
            {email && name !== email && <p className="truncate text-xs text-text-muted">{email}</p>}
            <p className="text-xs text-text-muted">{roleLabel}</p>
          </div>
          <div className="border-t border-border pt-1.5">
            <p id={themeLabelId} className="px-2.5 pb-1.5 text-xs text-text-muted">
              {t('nav.appearance')}
            </p>
            <div className="px-1 pb-1.5">
              <ThemeSegmentedControl labelledBy={themeLabelId} />
            </div>
          </div>
          <div className="border-t border-border pt-1.5">
            <Link to="/dashboard/account" onClick={() => { close(); onNavigate(); }} className={MENU_ITEM}>
              <Icon icon={User} size="sm" className="text-text-muted" />
              {t('nav.account.myAccount', { defaultValue: 'My account' })}
            </Link>
            <Link to="/dashboard/settings" onClick={() => { close(); onNavigate(); }} className={MENU_ITEM}>
              <Icon icon={Settings} size="sm" className="text-text-muted" />
              {t('nav.account.settings', { defaultValue: 'Settings' })}
            </Link>
            <button type="button" onClick={() => { close(); onShortcuts(); }} className={MENU_ITEM}>
              <Icon icon={Keyboard} size="sm" className="text-text-muted" />
              {t('nav.account.shortcuts', { defaultValue: 'Keyboard shortcuts' })}
            </button>
            <button type="button" onClick={() => { close(); onAccessibility(); }} className={MENU_ITEM}>
              <Icon icon={AccessibilityIcon} size="sm" className="text-text-muted" />
              {t('nav.accessibility', { defaultValue: 'Accessibility' })}
            </button>
          </div>
          <div className="mt-1.5 border-t border-border pt-1.5">
            <button type="button" onClick={() => { close(); onSignOut(); }} className={MENU_ITEM}>
              <Icon icon={LogOut} size="sm" className="text-text-muted" />
              {t('nav.signOut')}
            </button>
          </div>
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        data-testid="account-menu-trigger"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="focus-ring flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-bg-tertiary"
      >
        <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-xs font-semibold text-text-primary">
          {initial}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-4 text-text-primary">{name}</span>
          <span className="block truncate text-xs leading-4 text-text-muted">{roleLabel}</span>
        </span>
        <Icon icon={ChevronsUpDown} size="micro" className="text-text-muted" />
      </button>
    </div>
  );
}

export function filterItems(
  items: NavItem[],
  isOwner: boolean,
  permissions: import('@/contexts/AuthContext').UserPermissions,
  gatesOrHasModule?: NavGates | ((id: string) => boolean),
  isFlagOn?: (key: string) => boolean,
  enabledModules: ReadonlySet<string> = NO_MODULES,
  hasModuleArg?: (id: string) => boolean,
) {
  const gates: NavGates = typeof gatesOrHasModule === 'object' && gatesOrHasModule ? gatesOrHasModule : {};
  const hasModule = hasModuleArg ?? (typeof gatesOrHasModule === 'function' ? gatesOrHasModule : undefined);
  return items.filter((item) => {
    if (item.gate && !gates[item.gate]) return false;
    if (item.flag && !(isFlagOn?.(item.flag) ?? false)) return false;
    if (item.hiddenUnless && !enabledModules.has(item.hiddenUnless)) return false;
    if (item.requiresFlag && isFlagOn && !isFlagOn(item.requiresFlag)) return false;
    if (!passesModuleGate(item.requiresModule, hasModule)) return false;
    if (item.ownerOnly && !isOwner) return false;
    if (!item.requiresPermission) return true;
    if (isOwner) return true;
    return permissions[item.requiresPermission];
  });
}
export const ALL_NAV_ITEMS = [...PRIMARY_ITEMS, ...ACCOUNT_ITEMS];
const ALL_NAV_HREFS: readonly string[] = [...PRIMARY_ITEMS, ...ACCOUNT_ITEMS].map((item) => item.href);
export function DashboardNav({ activeLabel }: { activeLabel: string }) {
  const { has: hasModule } = useEntitlements();
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    rememberDashboardPath(location.pathname);
  }, [location.pathname]);
  const { user, isOwner, permissions, signOut } = useAuth();
  const { enabled: partsSourcingOn } = usePartsSourcingEnabled();
  const pestOps = usePestOpsAccess();
  const landscaping = useLandscapingAccess();
  const enabledModules: ReadonlySet<string> = new Set([
    ...(partsSourcingOn ? ['parts_sourcing'] : []),
    ...(pestOps.enabled ? ['pest_ops'] : []),
  ]);
  const { isEnabled: isFlagOn } = useFeatureFlags();
  const { toast } = useToast();
  const { t } = useTranslation('dashboard');
  const { isRtl } = useDirection();
  const label = (text: string) => t(navLabelKey(text), { defaultValue: text });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);

  // Power-user keyboard shortcuts (e.g. "g" then "o" for Overview, "?" for
  // this help panel) — wired once here so they work from anywhere in the
  // dashboard, since DashboardNav is mounted by every dashboard page via
  // DashboardLayout below.
  // Key bindings live in ONE registry (src/lib/shortcuts); this only supplies
  // what each shortcut DOES. Navigation/create handlers are derived from the
  // registry's own `href`s, so a binding can never point at a different route
  // than its palette entry.
  useShortcutScope(user?.id);
  useShortcutContext('dashboard');
  useShortcutHandlers({
    ...navigationHandlers((href, opts) => navigate(href, opts)),
    'help.shortcuts': () => setShortcutsHelpOpen(true),
  });

  const isActive = (href: string) => isNavItemActive(location.pathname, href, ALL_NAV_HREFS);

  const audience = audienceFor(isOwner, permissions.can_view_all_jobs);
  const gates = { landscaping: landscaping.allowed };
  const visiblePrimary = filterItems(PRIMARY_ITEMS, isOwner, permissions, gates, isFlagOn, enabledModules, hasModule);
  const visibleAccount = filterItems(ACCOUNT_ITEMS, isOwner, permissions, gates, isFlagOn, enabledModules, hasModule);
  const [showLabs, setShowLabs] = useState<boolean>(() => {
    try {
      return localStorage.getItem('vireek.labs') === '1';
    } catch {
      return false;
    }
  });
  const toggleLabs = () =>
    setShowLabs((v) => {
      const next = !v;
      try {
        localStorage.setItem('vireek.labs', next ? '1' : '0');
      } catch {
        /* storage blocked */
      }
      return next;
    });
  const labsVisible = showLabs || isLab(location.pathname);
  // Two-level menu: level 1 lists the pillars, level 2 (`panel`) drills into one pillar's hubs.
  const [panel, setPanel] = useState<PillarId | null>(() => {
    return pillarFor(location.pathname);
  });
  const [openHubs, setOpenHubs] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const backRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<Partial<Record<PillarId, HTMLButtonElement | null>>>({});
  const focusIntent = useRef<'back' | PillarId | null>(null);
  useEffect(() => {
    if (location.pathname === '/dashboard') setPanel(null);
    else {
      const p = pillarFor(location.pathname);
      if (p) setPanel(p);
    }
  }, [location.pathname]);
  useEffect(() => {
    const intent = focusIntent.current;
    if (!intent) return;
    focusIntent.current = null;
    if (intent === 'back') backRef.current?.focus();
    else rowRefs.current[intent]?.focus();
  }, [panel]);
  const simpleMode = useSimpleMode();
  const allVisible = [...visiblePrimary, ...visibleAccount];
  const pillarGroups = groupByPillar(simpleMode.active ? filterToSimpleNav(allVisible) : allVisible, { audience, showLabs: labsVisible && !simpleMode.active });
  const overview = visiblePrimary.find((i) => i.href === '/dashboard');

  const handleSignOut = async () => {
    await signOut();
    toast(t('nav.signedOut'), 'info');
    navigate('/login', { replace: true });
  };

  function NavLink({ item }: { item: NavItem }) {
    const active = isActive(item.href);
    return (
      <Link
        key={item.href}
        to={item.href}
        onClick={() => setDrawerOpen(false)}
        aria-current={active ? 'page' : undefined}
        className={`focus-ring group relative flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] leading-5 transition-colors ${
          active
            ? 'bg-bg-tertiary font-medium text-text-primary'
            : 'text-text-secondary hover:bg-bg-tertiary/70 hover:text-text-primary'
        }`}
      >
        {active && <span aria-hidden="true" className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-accent" />}
        <Icon icon={navIcon(item.href, item.icon)} size="sm" className={active ? 'text-accent' : 'text-text-muted group-hover:text-text-secondary'} />
        <span className="min-w-0 flex-1 truncate">{label(plainLabel(item.href, item.label))}</span>
        {item.href === '/dashboard/team-chat' && <ChatNavBadge />}
      </Link>
    );
  }

  const q = query.trim().toLowerCase();
  const panelGroup = panel ? pillarGroups.find((g) => g.pillar === panel) : undefined;
  const panelMeta = panel ? PILLARS.find((p) => p.id === panel) : undefined;
  const pillarTitle = (id: PillarId, fallback: string) => t(`nav.pillars.${id}`, { defaultValue: fallback });

  const openPanel = (id: PillarId) => {
    focusIntent.current = 'back';
    setQuery('');
    setPanel(id);
  };
  const closePanel = () => {
    focusIntent.current = panel;
    setQuery('');
    setPanel(null);
  };

  const levelOne = (
    <nav aria-label={t('nav.mainNavigation')} className="flex flex-col gap-0.5">
      {overview && <NavLink item={overview} />}
      <FrequentPages
        candidates={pillarGroups.flatMap((g) => g.items)}
        userId={user?.id}
        pathname={location.pathname}
        renderItem={(item) => <NavLink item={item} />}
      />
      <div className="mt-3 flex flex-col gap-0.5">
        {pillarGroups.map(({ pillar, items }) => {
          const meta = PILLARS.find((p) => p.id === pillar)!;
          const hasActive = items.some((i) => isActive(i.href));
          return (
            <button
              key={pillar}
              ref={(el) => {
                rowRefs.current[pillar] = el;
              }}
              type="button"
              onClick={() => openPanel(pillar)}
              className={`focus-ring group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-start text-[13px] leading-5 transition-colors hover:bg-bg-tertiary/70 hover:text-text-primary ${
                hasActive ? 'font-medium text-text-primary' : 'text-text-secondary'
              }`}
            >
              <Icon icon={PILLAR_ICONS[pillar]} size="sm" className={hasActive ? 'text-accent' : 'text-text-muted group-hover:text-text-secondary'} />
              <span className="min-w-0 flex-1 truncate">{pillarTitle(pillar, meta.label)}</span>
              {pillar === 'labs' && <span className="rounded bg-bg-tertiary px-1.5 text-[11px] font-medium text-text-secondary">Beta</span>}
              <span className="text-xs tabular-nums text-text-muted">{items.length}</span>
              <Icon icon={ChevronRight} size="micro" className="text-text-muted rtl:rotate-180" />
            </button>
          );
        })}
      </div>
      {simpleMode.eligible && (
        <button
          type="button"
          onClick={() => simpleMode.setShowEverything(!simpleMode.showEverything)}
          className="focus-ring mt-3 rounded-lg px-2.5 py-1.5 text-start text-xs font-medium text-accent hover:underline"
        >
          {simpleMode.showEverything ? t('nav.simple.hide', { defaultValue: 'Show simple menu' }) : t('nav.simple.show', { defaultValue: 'Show all features' })}
        </button>
      )}
      <button
        type="button"
        onClick={toggleLabs}
        hidden={simpleMode.active}
        className="focus-ring mt-1 rounded-lg px-2.5 py-1.5 text-start text-xs text-text-muted transition-colors hover:text-text-primary"
      >
        {showLabs ? t('nav.labs.hide', { defaultValue: 'Hide Labs (Beta)' }) : t('nav.labs.show', { defaultValue: 'Show Labs (Beta)' })}
      </button>
    </nav>
  );

  const levelTwo =
    panel && panelGroup && panelMeta ? (
      <nav aria-label={pillarTitle(panel, panelMeta.label)} className="flex flex-col gap-0.5">
        <button
          ref={backRef}
          type="button"
          onClick={closePanel}
          className="focus-ring flex items-center gap-2 rounded-lg px-2 py-1.5 text-start text-[13px] font-medium text-text-primary transition-colors hover:bg-bg-tertiary/70"
        >
          <Icon icon={ChevronLeft} size="sm" className="text-text-muted rtl:rotate-180" />
          <span className="min-w-0 flex-1 truncate">{pillarTitle(panel, panelMeta.label)}</span>
          <span className="sr-only">{t('nav.backToMenu', { defaultValue: 'Back to main menu' })}</span>
        </button>
        <p className="px-2.5 pb-2 pt-0.5 text-xs leading-4 text-text-muted">{panelMeta.blurb}</p>
        <div className="relative pb-2">
          <Icon icon={Search} size="sm" className="pointer-events-none absolute start-2.5 top-2 text-text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('nav.filter', { defaultValue: 'Filter pages' })}
            placeholder={t('nav.filter', { defaultValue: 'Filter pages' })}
            className="focus-ring w-full rounded-lg border border-border bg-bg-primary py-1.5 pe-2.5 ps-8 text-[13px] text-text-primary placeholder:text-text-muted"
          />
        </div>
        {(() => {
          const hubs = groupByHub(panel, panelGroup.items)
            .map(({ hub, items }) => ({
              hub,
              all: items,
              items: q
                ? items.filter((i) => `${label(plainLabel(i.href, i.label))} ${i.label} ${searchTerms(i.href)}`.toLowerCase().includes(q))
                : items,
            }))
            .filter((h) => h.items.length > 0);
          if (hubs.length === 0) {
            return (
              <p role="status" className="px-2.5 py-2 text-xs text-text-muted">
                {t('nav.noMatches', { defaultValue: 'No pages match your filter.' })}
              </p>
            );
          }
          return hubs.map(({ hub, all, items }) => {
            const hasActive = all.some((i) => isActive(i.href));
            const open = q ? true : (openHubs[hub.id] ?? (hasActive || hubs.length === 1));
            return (
              <div key={hub.id} className="mt-1">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenHubs((v) => ({ ...v, [hub.id]: !open }))}
                  className={`focus-ring flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-start text-[13px] font-medium transition-colors hover:bg-bg-tertiary/70 ${
                    hasActive ? 'text-text-primary' : 'text-text-secondary'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{t(`nav.hubs.${hub.id}`, { defaultValue: hub.label })}</span>
                  <span className="text-xs font-normal tabular-nums text-text-muted">{items.length}</span>
                  <Icon icon={ChevronDown} size="micro" className={`text-text-muted transition-transform duration-fast motion-reduce:transition-none ${open ? '' : '-rotate-90 rtl:rotate-90'}`} />
                </button>
                {open && (
                  <div className="ms-4 mt-0.5 flex flex-col gap-0.5 border-s border-border ps-1.5">
                    {items.map((item) => (
                      <NavLink key={item.href} item={item} />
                    ))}
                  </div>
                )}
              </div>
            );
          });
        })()}
      </nav>
    ) : null;

  const navContent = levelTwo ?? levelOne;

  const askDataButton = (
    <button
      type="button"
      data-tour="ask-data"
      onClick={() => { setDrawerOpen(false); openAskData(); }}
      className="focus-ring mt-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-start text-[13px] font-medium text-text-secondary transition-colors hover:bg-bg-tertiary/70 hover:text-text-primary"
    >
      <Icon icon={AskDataIcon} size="sm" className="text-text-muted" />
      <span className="flex-1">{t('nav.askData', { defaultValue: 'Ask your data' })}</span>
    </button>
  );

  const accountMenu = (
    <AccountMenu
      email={user?.email ?? ''}
      displayName={typeof user?.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : typeof user?.user_metadata?.name === 'string' ? user.user_metadata.name : undefined}
      roleLabel={isOwner ? t('nav.account.owner', { defaultValue: 'Owner' }) : t('nav.account.member', { defaultValue: 'Team member' })}
      onNavigate={() => setDrawerOpen(false)}
      onShortcuts={() => setShortcutsHelpOpen(true)}
      onAccessibility={() => openAccessibilityCenter()}
      onSignOut={handleSignOut}
    />
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        data-active-label={activeLabel}
        className="fixed left-0 top-0 z-30 hidden h-full w-60 flex-col border-r border-border bg-bg-secondary [--icon-stroke:1.5] lg:flex print:hidden"
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-1 px-3">
          <Link to="/dashboard" aria-label="Vireek" className="focus-ring flex shrink-0 items-center rounded-lg px-1.5 py-1">
            <Logo variant="symbol" size={22} decorative />
          </Link>
          <div className="flex items-center">
            <ReplayTourMenu align="start" />
            <FeedbackButton />
            <WhatsNewButton />
            <NotificationBell />
          </div>
        </div>
        <div className="shrink-0 px-3 pb-2">
          <SidebarSearchButton />
          {askDataButton}
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-4 pt-1">{navContent}</div>
        <div className="shrink-0 border-t border-border p-3">{accountMenu}</div>
      </aside>

      {/* Mobile header */}
      <header className="sticky top-0 z-40 border-b border-border bg-bg-secondary lg:hidden print:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <Link to="/dashboard" aria-label="Vireek" className="focus-ring flex items-center rounded-lg">
            <Logo variant="wordmark" size={18} decorative />
          </Link>
          <div className="flex items-center gap-2">
            <ReplayTourMenu align="end" />
            <FeedbackButton />
            <WhatsNewButton />
            <NotificationBell />
            <IconButton
              label={t('nav.openMenu')}
              icon={Menu}
              variant="secondary"
              size="sm"
              onClick={() => setDrawerOpen(true)}
              data-tour="menu-button"
            />
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
              className="fixed inset-0 z-50 bg-overlay/40 lg:hidden"
            />
            <motion.aside
              initial={{ x: isRtl ? '100%' : '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: isRtl ? '100%' : '-100%' }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="fixed left-0 top-0 z-50 flex h-full w-72 max-w-[85vw] flex-col border-r border-border bg-bg-secondary [--icon-stroke:1.5] lg:hidden"
            >
              <div className="flex h-14 shrink-0 items-center justify-between px-4">
                <Logo variant="wordmark" size={18} />
                <IconButton
                  label={t('nav.closeMenu')}
                  icon={X}
                  variant="secondary"
                  size="sm"
                  onClick={() => setDrawerOpen(false)}
                />
              </div>
              <div className="shrink-0 px-3 pb-2">
                <SidebarSearchButton />
                {askDataButton}
              </div>
              <div className="flex-1 overflow-y-auto px-3 pb-4 pt-1">{navContent}</div>
              <div className="shrink-0 border-t border-border p-3">{accountMenu}</div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Mobile bottom navigation — "More" opens the same drawer as the header menu button */}
      <MobileBottomNav onMore={() => setDrawerOpen(true)} moreOpen={drawerOpen} />
      {/* Keyboard shortcuts help panel — opened via "?" from anywhere */}
      <KeyboardShortcutsModal open={shortcutsHelpOpen} onClose={() => setShortcutsHelpOpen(false)} />
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
  const { i18n } = useTranslation('dashboard');
  return (
    // NotificationsProvider wraps everything here (not just <DashboardNav>)
    // because DashboardNav itself renders TWO <NotificationBell /> instances
    // at once (desktop sidebar + mobile header — CSS just hides one of
    // them, both stay mounted). One provider = one realtime subscription
    // shared by both bells, instead of each opening its own and colliding.
    // See NotificationsContext.tsx for the full story on the bug this fixes.
    <NotificationsProvider>
      <WhatsNewProvider>
        <ChatUnreadProvider>
          <div className="min-h-screen bg-bg-primary [&_svg.lucide]:[stroke-width:1.5]">
            <DashboardNav activeLabel={activeLabel} />
            <ImpersonationBanner />
            <div className="lg:pl-60 print:pl-0">
              <main id="main-content" className="mx-auto max-w-7xl px-4 py-6 pb-[calc(var(--vk-bottom-nav-h,0px)+var(--vk-bottom-bar-h,0px)+2rem)] lg:px-8 lg:py-8 print:max-w-none print:p-0">
                <Breadcrumbs className="no-print mb-4" />
                <div className="no-print">
                {/* Banner queue: order = priority, and only the first banner that renders is shown. Each banner
                    renders one root element or nothing, so hiding later siblings is safe (they stay mounted). */}
                <div className="no-print [&>*:not(:first-child)]:!hidden">
                  <SecurityAlertBanner />
                  <PaymentFailedBanner />
                  <IncidentBanner />
                  <UsageLimitBanner />
                  <SurgeModeBanner />
                  <TrialBanner />
                  <UpgradeBanner />
                  <ActivePlaybookBanner />
                  <PwaInstallBanner />
                </div>
                <div key={i18n.language} className="contents">
                  {children}
                </div>
              </main>
            </div>
            <div className="no-print">
              <TaskReminderWatcher />
              <SupportDock />
              <GlobalSearchPalette />
              <AiAssistant />
              <NpsPrompt />
              <SurveyHost />
              <FeedbackDialog />
              <WhatsNewDrawer />
            </div>
          </div>
        </ChatUnreadProvider>
      </WhatsNewProvider>
    </NotificationsProvider>
  );
}
