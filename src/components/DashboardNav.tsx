import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { LayoutTemplate } from 'lucide-react';
import { ClipboardList } from 'lucide-react';
import {
  BarChart3,
  FileUp,
  LayoutTemplate,
  Globe,
  BookOpen,
  BookMarked,
  ClipboardCheck,
  Link2,
  QrCode,
  ScrollText,
  Home,
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
  Inbox,
  Target,
  Users,
  Wrench,
  BookUser,
  Brain,
  Settings,
  Lightbulb,
  GraduationCap,
  Gauge,
  Compass,
  Hourglass,
  Waves,
  ShieldCheck,
  Scale,
  BadgePercent,
  Tags,
  TicketPercent,
  FlaskConical,
  FolderLock,
  Hourglass,
  Bot,
  Ban,
  Users2,
  CreditCard,
  MessagesSquare,
  Plug,
  ChevronDown,
  Sparkles,
  BrainCircuit,
  Headset,
  BadgeCheck,
  Rocket,
  Timer,
  Star,
  Smile,
  Voicemail,
  PhoneOutgoing,
  Gift,
  AudioLines,
  Megaphone,
  MailPlus,
  Filter,
  Award,
   DollarSign,
   Calculator,
   Route,
   AlertOctagon,
   GitBranch,
   ShieldCheck,
  FileText,
  FileBarChart,
  CalendarClock,
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
  Wallet,
  Flame,
 Landmark,
  MapPin,
  AlarmClock,
  BellRing,
  LifeBuoy,
  Workflow,
  Network,
  Package,
  ArrowRightLeft,
  Shuffle,
  Truck,
  Building2,
  Fuel,
  ScanEye,
  ClipboardList,
  ListChecks,
  Navigation,
  Siren,
  Layers,
  FolderKanban,
  GitBranch,
  MousePointerClick,
  Library,
  Handshake,
  Store,
  PackageSearch,
  HeartPulse,
  Factory,
  MessageSquareWarning,
  CalendarOff,
  MessageSquareText,
  MessageSquareHeart,
  MessageSquare,
  ShieldCheck,
  Target,
  Stethoscope,
  ClipboardCheck,
  Radar,
  Fingerprint,
  Dna,
  Crosshair,
  Microscope,
  MessageCircle,
  Compass,
  Receipt,
  Coins,
  Percent,
  Monitor,
  Moon,
  Sun,
  Check,
  Skull,
  FileSearch,
  FileCheck2,
  UserMinus,
  BrainCircuit,
  Infinity as InfinityIcon,
  BrainCircuit,
  Satellite,
  Navigation,
  Beaker
  Landmark,
  Undo2,
  FileBarChart,
  Trash2,
  GitMerge,
  FolderDown,
  SlidersHorizontal,
  Images,
  Paintbrush,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { rememberDashboardPath } from '@/lib/helpCenter';
import { useToast } from '@/contexts/ToastContext';
import { NotificationsProvider } from '@/contexts/NotificationsContext';
import { useTheme } from '@/contexts/ThemeContext';
import { UpgradeBanner } from '@/components/UpgradeBanner';
import { SurgeModeBanner } from '@/components/SurgeModeBanner';
import { PaymentFailedBanner } from '@/components/PaymentFailedBanner';
import { UsageLimitBanner } from '@/components/UsageLimitBanner';
import { NotificationBell } from '@/components/NotificationBell';
import { WhatsNewButton } from '@/components/whats-new/WhatsNewButton';
import { WhatsNewProvider } from '@/contexts/WhatsNewContext';
import { LocationSwitcher } from '@/components/locations/LocationSwitcher';
import { AiAssistant } from '@/components/AiAssistant';
import { GlobalSearchPalette } from '@/components/GlobalSearchPalette';
import { TaskReminderWatcher } from '@/components/tasks/TaskReminderWatcher';
import { ChatUnreadProvider } from '@/contexts/ChatUnreadContext';
import { ChatNavBadge } from '@/components/teamchat/ChatNavBadge';
import { useKeyboardShortcuts, DEFAULT_SHORTCUTS } from '@/lib/keyboardShortcuts';
import { KeyboardShortcutsModal } from '@/components/KeyboardShortcutsModal';
import { useTranslation } from 'react-i18next';
import { useDirection } from '@/hooks/useDirection';
import { navLabelKey } from '@/lib/navLabel';

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
  { label: 'Support', href: '/dashboard/support', icon: LifeBuoy },
  { label: 'Getting Started', href: '/dashboard/getting-started', icon: Rocket },
  { label: 'Calendar', href: '/dashboard/calendar', icon: Calendar },
  { label: 'My Jobs', href: '/dashboard/jobs', icon: Wrench },
  { label: 'Install Projects', href: '/dashboard/projects', icon: FolderKanban, requiresPermission: 'can_view_billing' },
  { label: 'Tasks', href: '/dashboard/tasks', icon: ListChecks },
  { label: 'Team Chat', href: '/dashboard/team-chat', icon: MessagesSquare },
  { label: 'Live Calls', href: '/dashboard/live-calls', icon: Radio, requiresPermission: 'can_manage_numbers' },
  { label: 'Call History', href: '/dashboard/calls', icon: PhoneCall },
  { label: 'CSR Phone Desk', href: '/dashboard/csr-desk', icon: Headset, requiresPermission: 'can_view_all_jobs' },
  { label: 'Inbox', href: '/dashboard/inbox', icon: Inbox },
  { label: 'Goals', href: '/dashboard/goals', icon: Target },
  { label: 'Coaching Reports', href: '/dashboard/coaching-reports', icon: GraduationCap, requiresPermission: 'can_view_billing' },
  { label: 'Price Accuracy', href: '/dashboard/price-accuracy', icon: ShieldCheck, requiresPermission: 'can_view_billing' },
  { label: 'Voicemails', href: '/dashboard/voicemails', icon: Voicemail },
  { label: 'Leads', href: '/dashboard/leads', icon: Users },
  { label: 'Customers', href: '/dashboard/customers', icon: BookUser },
  { label: 'Equipment Intelligence', href: '/dashboard/equipment', icon: Wrench },
  { label: 'Building Telemetry', href: '/dashboard/building-telemetry', icon: Cpu },
  { label: 'Customer Intelligence', href: '/dashboard/customer-intelligence', icon: Brain, requiresPermission: 'can_view_billing' },
  { label: 'Quotes', href: '/dashboard/quotes', icon: FileText },
  { label: 'Outbound Campaigns', href: '/dashboard/outbound-campaigns', icon: PhoneOutgoing },
  { label: 'Voicemail Drops', href: '/dashboard/voicemail-drops', icon: AudioLines, requiresPermission: 'can_view_billing' },
  { label: 'Neighborhood Revenue', href: '/dashboard/neighborhood-revenue', icon: MapPinned, requiresPermission: 'can_view_billing' },
  { label: 'Marketing Automation', href: '/dashboard/marketing', icon: Megaphone },
  { label: 'Referrals', href: '/dashboard/referrals', icon: Gift, requiresPermission: 'can_view_billing' },
  { label: 'Email Campaigns', href: '/dashboard/email-campaigns', icon: MailPlus, requiresPermission: 'can_view_billing' },
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
  { label: 'Phone Numbers', href: '/dashboard/phone-numbers', icon: Phone },
  { label: 'Blocklist & DNC', href: '/dashboard/blocklist', icon: Ban, requiresPermission: 'can_manage_numbers' },
  { label: 'Call Routing', href: '/dashboard/call-routing', icon: Workflow, requiresPermission: 'can_manage_numbers' },
  { label: 'Usage Dashboard', href: '/dashboard/usage', icon: Gauge, requiresPermission: 'can_view_billing' },
  { label: 'Insights', href: '/dashboard/insights', icon: Lightbulb },
  { label: 'Decision Engine', href: '/dashboard/decision-engine', icon: Cpu, requiresPermission: 'can_view_billing' },
  { label: 'Ask Vireek', href: '/dashboard/ask-vireek', icon: BrainCircuit, requiresPermission: 'can_view_billing' },
  { label: 'Causal World Simulator', href: '/dashboard/causal-simulator', icon: GitBranch, requiresPermission: 'can_view_billing' },
  { label: 'Continual Identity Learner', href: '/dashboard/identity-learner', icon: Radar, requiresPermission: 'can_view_billing' },
  { label: 'Regret Console', href: '/dashboard/regret-console', icon: Scale, requiresPermission: 'can_view_billing' },
  { label: 'Business Scientist', href: '/dashboard/business-scientist', icon: FlaskConical, requiresPermission: 'can_view_billing' },
  { label: 'AI Field Scientist', href: '/dashboard/field-scientist', icon: Microscope, requiresPermission: 'can_view_billing' },
  { label: 'Self-Evolving Operating Model', href: '/dashboard/operating-model', icon: Sparkles, requiresPermission: 'can_view_billing' },
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
  { label: 'Revenue Map', href: '/dashboard/revenue-map', icon: MapPinned, requiresPermission: 'can_view_billing' },
  { label: 'Cash Flow Forecast', href: '/dashboard/cash-flow', icon: PiggyBank, requiresPermission: 'can_view_billing' },
  { label: 'Business Forecast', href: '/dashboard/business-forecast', icon: TrendingUp, requiresPermission: 'can_view_billing' },
  { label: 'Cash Flow War Room', href: '/dashboard/cash-flow-war-room', icon: Flame, requiresPermission: 'can_view_billing' },
  { label: 'Direct Bank Intelligence', href: '/dashboard/bank-intelligence', icon: Landmark, requiresPermission: 'can_view_billing' },
  { label: 'Regional Demand', href: '/dashboard/regional-demand', icon: MapPin, requiresPermission: 'can_view_billing' },
  { label: 'Dispatch Board', href: '/dashboard/dispatch', icon: Route },
  { label: 'Context Engine', href: '/dashboard/context-engine', icon: Radar },
  { label: 'Advanced Routing', href: '/dashboard/routing', icon: Navigation },
  { label: 'Service Areas', href: '/dashboard/service-areas', icon: MapPinned, requiresPermission: 'can_view_all_jobs' },
  { label: 'On-Call Rotation', href: '/dashboard/on-call', icon: AlarmClock },
  { label: 'Notification Routing', href: '/dashboard/notification-routing', icon: BellRing, ownerOnly: true },
  { label: 'Mutual Aid', href: '/dashboard/mutual-aid', icon: LifeBuoy },
  { label: 'Contractor Network', href: '/dashboard/network', icon: Network },
  { label: 'Emergency Network', href: '/dashboard/emergency-network', icon: Siren },
  { label: 'Job Handoffs', href: '/dashboard/network/handoffs', icon: ArrowRightLeft },
  { label: 'Home Demand Exchange', href: '/dashboard/demand-exchange', icon: Radar, requiresPermission: 'can_view_billing' },
  { label: 'Capacity Exchange', href: '/dashboard/network/capacity-exchange', icon: Shuffle },
  { label: 'Skill Market', href: '/dashboard/network/skill-market', icon: Globe2 },
  { label: 'Insurance Claims', href: '/dashboard/insurance-claims', icon: ShieldAlert },
  { label: 'Risk Intelligence', href: '/dashboard/risk-intelligence', icon: Gauge },
  { label: 'Compliance Center', href: '/dashboard/compliance', icon: ShieldCheck },
  { label: 'Permit Center', href: '/dashboard/permits', icon: ClipboardCheck },
  { label: 'Documents', href: '/dashboard/documents', icon: FolderLock },
  { label: 'Gallery', href: '/dashboard/gallery', icon: Images },
  { label: 'Callback Root-Cause', href: '/dashboard/callback-root-cause', icon: Microscope },
  { label: 'AI Job Autopsy', href: '/dashboard/job-autopsy', icon: Stethoscope },
  { label: 'Autonomy Readiness', href: '/dashboard/autonomy-readiness', icon: Gauge },
  { label: 'Accounting', href: '/dashboard/accounting', icon: BookOpen },
  { label: 'Budgets', href: '/dashboard/budgets', icon: Wallet, requiresPermission: 'can_view_billing' },
  { label: 'Refunds', href: '/dashboard/refunds', icon: Undo2, requiresPermission: 'can_view_billing' },
  { label: 'Chart of Accounts', href: '/dashboard/chart-of-accounts', icon: Layers, requiresPermission: 'can_view_billing' },
  { label: 'Bank Intelligence', href: '/dashboard/bank-intelligence', icon: Landmark },
  { label: 'Payroll', href: '/dashboard/payroll', icon: DollarSign },
  { label: 'Expenses', href: '/dashboard/expenses', icon: Receipt },
  { label: 'Commissions', href: '/dashboard/commissions', icon: Coins, requiresPermission: 'can_view_billing' },
  { label: 'Job Quality Gate', href: '/dashboard/job-quality-gate', icon: ClipboardCheck },
  { label: 'Evidence Chain', href: '/dashboard/evidence-chain', icon: Link2 },
  { label: 'Warranty Claim Recovery', href: '/dashboard/warranty-claims', icon: FileClock },
  { label: 'Business Immune System', href: '/dashboard/immune-system', icon: Siren },
  { label: 'Compounding Flywheel', href: '/dashboard/flywheel', icon: Sparkles },
  { label: 'Adaptive Diagnostic', href: '/dashboard/adaptive-diagnostics', icon: BrainCircuit },
  { label: 'Predictive Failure', href: '/dashboard/predictive-failure', icon: Radar },
  { label: 'Preventive Maintenance', href: '/dashboard/preventive-maintenance', icon: CalendarClock, requiresPermission: 'can_view_all_jobs' },
  { label: 'Verification Network', href: '/dashboard/verification-network', icon: BadgeCheck },
  { label: 'Physical Economy Network', href: '/dashboard/physical-economy-network', icon: Network },
  { label: 'Service Recovery', href: '/dashboard/service-recovery', icon: HeartHandshake },
  { label: 'Surveys', href: '/dashboard/surveys', icon: MessageSquareHeart, requiresPermission: 'can_view_billing' },
  { label: 'Self-Healing', href: '/dashboard/self-healing', icon: Bot },
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
  { label: 'Promise Tracker', href: '/dashboard/promises', icon: Handshake },
  { label: 'Service Recovery', href: '/dashboard/service-recovery', icon: MessageSquareWarning },
  { label: 'Memberships', href: '/dashboard/memberships', icon: Award },
  { label: 'Gift Cards', href: '/dashboard/gift-cards', icon: Gift, requiresPermission: 'can_view_billing' },
  { label: 'Recurring Jobs', href: '/dashboard/recurring-jobs', icon: Repeat, requiresPermission: 'can_view_billing' },
  { label: 'My Day (Field)', href: '/tech/today', icon: Wrench },
  { label: 'Weekly Schedule (Field)', href: '/tech/schedule', icon: Calendar },
  { label: 'Expert Assist', href: '/dashboard/expert-assist', icon: LifeBuoy },
  { label: 'Field Messages', href: '/dashboard/field-messages', icon: MessageSquare },
  { label: 'Price Book', href: '/dashboard/price-book', icon: DollarSign },
  { label: 'Price Lists', href: '/dashboard/price-lists', icon: Tags, requiresPermission: 'can_view_billing' },
  { label: 'Form Builder', href: '/dashboard/form-builder', icon: ClipboardList, requiresPermission: 'can_edit_business_profile' },
  { label: 'Job Templates', href: '/dashboard/job-templates', icon: LayoutTemplate, requiresPermission: 'can_view_billing' },
  { label: 'Service Catalog', href: '/dashboard/service-catalog', icon: ClipboardList, requiresPermission: 'can_view_billing' },
  { label: 'Underpriced Jobs', href: '/dashboard/underpriced-jobs', icon: TrendingDown, requiresPermission: 'can_view_billing' },
  { label: 'Equipment Health', href: '/dashboard/equipment-health', icon: HeartPulse },
  { label: 'Equipment Passports', href: '/dashboard/equipment-passports', icon: QrCode },
  { label: 'Home Passports', href: '/dashboard/home-passports', icon: Home },
  { label: 'OEM Intelligence', href: '/dashboard/oem-intelligence', icon: Factory },
  { label: 'OEM Intelligence Graph', href: '/dashboard/oem-graph', icon: Network },
  { label: 'Universal Identity', href: '/dashboard/identity-graph', icon: Fingerprint },
  { label: 'Field Intelligence', href: '/dashboard/field-intelligence', icon: Brain },
  { label: 'Home Health', href: '/dashboard/home-health', icon: Activity },
  { label: 'Home Service Passport', href: '/dashboard/home-passport', icon: ShieldCheck, requiresPermission: 'can_view_billing' },
  { label: 'Property Intelligence', href: '/dashboard/property-intelligence', icon: Radar },
  { label: 'Fleet Economics', href: '/dashboard/fleet-economics', icon: Fuel },
  { label: 'Telematics OS', href: '/dashboard/telematics', icon: Satellite },
  { label: 'Live Map', href: '/dashboard/live-map', icon: Navigation, requiresPermission: 'can_view_all_jobs' },
  { label: 'Fleet Intelligence', href: '/dashboard/fleet-intelligence', icon: Radar },
  { label: 'Vehicles', href: '/dashboard/vehicles', icon: Truck, requiresPermission: 'can_manage_team' },
  { label: 'Vehicle Inspections (DVIR)', href: '/dashboard/fleet-dvir', icon: ClipboardCheck },
  { label: 'Field Evidence', href: '/dashboard/field-evidence', icon: ScanEye },
  { label: 'Property Vision', href: '/dashboard/property-vision', icon: ScanEye },
  { label: 'Customer Trust Bank', href: '/dashboard/trust-bank', icon: ShieldCheck },
  { label: 'Next Best Actions', href: '/dashboard/next-best-actions', icon: Target },
  { label: 'Call Queue', href: '/dashboard/call-queue', icon: PhoneCall },
  { label: 'Diagnosis Copilot', href: '/dashboard/diagnosis-copilot', icon: Stethoscope },
  { label: 'Remote Resolution', href: '/dashboard/remote-resolution', icon: PhoneCall },
  { label: 'Service Intelligence Loop', href: '/dashboard/service-intelligence-loop', icon: Network },
  { label: 'Failure Genome', href: '/dashboard/failure-genome', icon: Dna },
  { label: 'Adaptive Diagnostics', href: '/dashboard/adaptive-diagnostics', icon: BrainCircuit },
  { label: 'Live Copilot', href: '/dashboard/live-copilot', icon: Radio },
  { label: 'Margin Guardrails', href: '/dashboard/margin-guardrails', icon: ShieldCheck, requiresPermission: 'can_view_billing' },
  { label: 'Promo Codes', href: '/dashboard/promo-codes', icon: TicketPercent, requiresPermission: 'can_view_billing' },
  { label: 'Quote Truth Engine', href: '/dashboard/quote-truth', icon: Scale, requiresPermission: 'can_view_billing' },
  { label: 'Operational Truth', href: '/dashboard/operational-truth', icon: ShieldCheck },
  { label: 'Incentive Engine', href: '/dashboard/incentives', icon: BadgePercent, requiresPermission: 'can_view_billing' },
  { label: 'Rebate Intelligence', href: '/dashboard/rebate-intelligence', icon: PiggyBank },
  { label: 'Energy Intelligence', href: '/dashboard/energy-intelligence', icon: Zap },
  { label: 'Automation Marketplace', href: '/dashboard/automation-marketplace', icon: Zap },
  { label: 'Company Reflexes', href: '/dashboard/reflexes', icon: Zap },
  { label: 'Workflows', href: '/dashboard/workflows', icon: Workflow },
  { label: 'Workflow Compiler', href: '/dashboard/workflow-compiler', icon: Sparkles },
  { label: 'Franchise Command Center', href: '/dashboard/franchise', icon: Building2 },
  { label: 'Franchise Governance', href: '/dashboard/franchise/governance', icon: Gavel },
  { label: 'Event Bus', href: '/dashboard/event-bus', icon: Webhook },
  { label: 'Event Prediction Mesh', href: '/dashboard/event-prediction-mesh', icon: Radar },
  { label: 'Reliability & Observability', href: '/dashboard/reliability', icon: Activity },
  { label: 'Activity Ledger', href: '/dashboard/activity-ledger', icon: History },
  { label: 'Technician Capacity', href: '/dashboard/technician-capacity', icon: Lock },
  { label: 'Capacity Demand Control', href: '/dashboard/capacity-demand', icon: Gauge },
  { label: 'Workforce Equilibrium', href: '/dashboard/workforce-equilibrium', icon: Scale },
  { label: 'Business Drift Detector', href: '/dashboard/business-drift', icon: Compass },
  { label: 'Executive Reports', href: '/dashboard/reports/executive', icon: FileBarChart, ownerOnly: true },
  { label: 'Opportunity Cost Ledger', href: '/dashboard/opportunity-cost', icon: Hourglass },
  { label: 'Causal Shock Simulator', href: '/dashboard/causal-shock-simulator', icon: Waves },
  { label: 'Technician Performance', href: '/dashboard/technician-performance', icon: Gauge, requiresPermission: 'can_view_billing' },
  { label: 'Lead Marketplaces', href: '/dashboard/lead-marketplaces', icon: Target, requiresPermission: 'can_view_billing' },
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
  { label: 'Knowledge Capture', href: '/dashboard/knowledge-capture', icon: Brain },
  { label: 'Revenue Protection', href: '/dashboard/revenue-protection', icon: ShieldCheck, requiresPermission: 'can_view_billing' },
  { label: 'Recovery Ledger', href: '/dashboard/recovery', icon: TrendingUp, requiresPermission: 'can_view_billing' },
  { label: 'Benchmarks', href: '/dashboard/benchmarks', icon: BarChart3, requiresPermission: 'can_view_billing' },
  { label: 'Outcome Benchmarks', href: '/dashboard/outcome-benchmarks', icon: BarChart3, requiresPermission: 'can_view_billing' },
  { label: 'Data Exchange', href: '/dashboard/data-exchange', icon: Handshake, requiresPermission: 'can_view_billing' },
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
  { label: 'Collections', href: '/dashboard/collections', icon: PhoneCall, requiresPermission: 'can_view_billing' },
  { label: 'Community', href: '/dashboard/community', icon: MessageCircle },
  { label: 'Feedback', href: '/dashboard/feedback', icon: Lightbulb },
  { label: 'Negative Knowledge Store', href: '/dashboard/negative-knowledge', icon: History },
  { label: 'Commitment Graph', href: '/dashboard/commitments', icon: ShieldCheck },
  { label: 'Evolution Roadmap', href: '/dashboard/roadmap', icon: Compass, requiresPermission: 'can_view_billing' },
  { label: 'Business Constitution', href: '/dashboard/constitution', icon: Scale },
  { label: 'Market Intelligence', href: '/dashboard/market-intelligence', icon: Network },
  { label: 'Identity Learner', href: '/dashboard/identity', icon: Fingerprint, requiresPermission: 'can_view_billing' },
  { label: 'Governance Center', href: '/dashboard/governance', icon: ShieldAlert },
  { label: 'Value at Risk', href: '/dashboard/value-at-risk', icon: Radar, requiresPermission: 'can_view_billing' },
  { label: 'Revenue Autopsy', href: '/dashboard/revenue-autopsy', icon: Skull, requiresPermission: 'can_view_billing' },
  { label: 'LTV Autopilot', href: '/dashboard/ltv-autopilot', icon: Rocket, requiresPermission: 'can_view_billing' },
  { label: 'Bottleneck Market Maker', href: '/dashboard/bottleneck-market', icon: Crosshair, requiresPermission: 'can_view_billing' },
  { label: 'Uncertainty & Evidence Map', href: '/dashboard/uncertainty-map', icon: Fingerprint, requiresPermission: 'can_view_billing' },
  { label: 'Unknowns Engine', href: '/dashboard/unknowns', icon: Brain, requiresPermission: 'can_view_billing' },
  { label: 'Playbooks', href: '/dashboard/playbooks', icon: BookMarked, requiresPermission: 'can_edit_business_profile' },
  { label: 'Templates', href: '/dashboard/templates', icon: MessageSquareText, requiresPermission: 'can_edit_business_profile' },
  { label: 'Trade Playbooks', href: '/dashboard/trade-playbooks', icon: ClipboardCheck, requiresPermission: 'can_edit_business_profile' },
  { label: 'Agent Governance', href: '/dashboard/agent-governance', icon: Bot, requiresPermission: 'can_manage_security' },
  { label: 'AI Security Center', href: '/dashboard/security-center', icon: LockKeyhole, requiresPermission: 'can_manage_security' },
  { label: 'AI Reliability', href: '/dashboard/ai-reliability', icon: ShieldCheck, requiresPermission: 'can_manage_security' },
  { label: 'Multi-Agent Company', href: '/dashboard/agent-company', icon: Users2, requiresPermission: 'can_manage_security' },
  { label: 'Agent Network', href: '/dashboard/agent-network', icon: Network, requiresPermission: 'can_manage_security' },
  { label: 'Evaluation Plane', href: '/dashboard/evaluation-plane', icon: Microscope, requiresPermission: 'can_view_billing' },
  { label: 'Agent Marketplace', href: '/dashboard/agent-marketplace', icon: Store },
  { label: 'Autonomy Budget', href: '/dashboard/autonomy-budget', icon: Timer, requiresPermission: 'can_manage_security' },
  { label: 'Execution Reliability', href: '/dashboard/execution-reliability', icon: Gauge, requiresPermission: 'can_view_billing' },
  { label: 'Vendor & Procurement', href: '/dashboard/procurement', icon: Truck, requiresPermission: 'can_view_billing' },
  { label: 'Vendor Management', href: '/dashboard/vendors', icon: Building2, requiresPermission: 'can_view_billing' },
  { label: 'AI Parts Market', href: '/dashboard/parts-market', icon: Store, requiresPermission: 'can_view_billing' },
  { label: 'Parts Intelligence', href: '/dashboard/parts-intelligence', icon: PackageSearch, requiresPermission: 'can_view_billing' },
  { label: 'Supplier Intelligence', href: '/dashboard/supplier-intelligence', icon: Handshake, requiresPermission: 'can_view_billing' },
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


const ACCOUNT_ITEMS: NavItem[] = [
  { label: 'My Account', href: '/dashboard/account', icon: User },
  { label: 'Business Profile', href: '/dashboard/business-profile', icon: Settings, requiresPermission: 'can_edit_business_profile' },
  { label: 'Branding', href: '/dashboard/settings/branding', icon: Paintbrush, requiresPermission: 'can_edit_business_profile' },
  { label: 'Locations', href: '/dashboard/settings/locations', icon: Building2, requiresPermission: 'can_edit_business_profile' },
  { label: 'Team', href: '/dashboard/team', icon: ShieldCheck, requiresPermission: 'can_manage_team' },
  { label: 'Time Off', href: '/dashboard/time-off', icon: CalendarOff, requiresPermission: 'can_manage_team' },
  { label: 'Billing', href: '/dashboard/billing', icon: CreditCard, requiresPermission: 'can_view_billing' },
  { label: 'Slack & Teams', href: '/dashboard/settings/slack-teams', icon: MessageSquareWarning, requiresPermission: 'can_manage_team' },
  { label: 'Billing Invoices', href: '/dashboard/billing/invoices', icon: Receipt, requiresPermission: 'can_view_billing' },
  { label: 'Plans & Upgrades', href: '/dashboard/billing/plans', icon: Rocket, requiresPermission: 'can_view_billing' },
  { label: 'Payments', href: '/dashboard/payments', icon: CreditCard, requiresPermission: 'can_view_billing' },
  { label: 'Financing Center', href: '/dashboard/financing', icon: Landmark, requiresPermission: 'can_view_billing' },
  { label: 'Benchmarks', href: '/dashboard/benchmarks', icon: TrendingUp, requiresPermission: 'can_view_billing' },
  { label: 'Integrations', href: '/dashboard/integrations', icon: Plug },
  { label: 'Data Imports', href: '/dashboard/imports', icon: FileUp, requiresPermission: 'can_edit_business_profile' },
  { label: 'CRM Sync', href: '/dashboard/crm-sync', icon: Workflow, requiresPermission: 'can_edit_business_profile' },
  { label: 'Custom Fields', href: '/dashboard/custom-fields', icon: SlidersHorizontal, requiresPermission: 'can_edit_business_profile' },
  { label: 'Exports', href: '/dashboard/exports', icon: FolderDown, requiresPermission: 'can_export_data' },
  { label: 'Duplicates', href: '/dashboard/duplicates', icon: GitMerge, requiresPermission: 'can_view_billing' },
  { label: 'Trash', href: '/dashboard/trash', icon: Trash2, requiresPermission: 'can_view_billing' },
  { label: 'Settings', href: '/dashboard/settings', icon: Settings },
  { label: 'Chat Widget', href: '/dashboard/settings/chat-widget', icon: MessageCircle, requiresPermission: 'can_edit_business_profile' },
  { label: 'What’s New', href: '/dashboard/whats-new', icon: Sparkles },
  { label: 'Help', href: '/dashboard/help', icon: LifeBuoy },
];

const THEME_OPTIONS: { value: 'dark' | 'light' | 'system'; label: string; icon: typeof Sun }[] = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
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
  useEffect(() => {
    rememberDashboardPath(location.pathname);
  }, [location.pathname]);
  const { isOwner, permissions, signOut } = useAuth();
  const { toast } = useToast();
  const { preference, setThemePreference } = useTheme();
  const { t } = useTranslation('dashboard');
  const { isRtl } = useDirection();
  const label = (text: string) => t(navLabelKey(text), { defaultValue: text });
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
    if (href === '/dashboard/inventory') return location.pathname === '/dashboard/inventory';
    return location.pathname.startsWith(href);
  };

  const visiblePrimary = filterItems(PRIMARY_ITEMS, isOwner, permissions);
  const visibleAccount = filterItems(ACCOUNT_ITEMS, isOwner, permissions);
  const accountActive = visibleAccount.some((item) => isActive(item.href));
  const [accountOpen, setAccountOpen] = useState(accountActive);
  const [themeOpen, setThemeOpen] = useState(false);

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
        className={`focus-ring flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
          active
            ? 'bg-accent/10 text-accent shadow-sm ring-1 ring-accent/15'
            : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
        }`}
      >
        <item.icon size={18} className={active ? 'text-accent' : 'text-text-secondary'} />
        {label(item.label)}
        {item.href === '/dashboard/team-chat' && <ChatNavBadge />}
      </Link>
    );
  }

  const navContent = (
    <nav aria-label={t('nav.mainNavigation')} className="flex flex-col gap-1">
      {visiblePrimary.map((item) => (
        <NavLink key={item.href} item={item} />
      ))}

      {visibleAccount.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => {t('nav.account')}((v) => !v)}
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

      <div className="mt-2">
        <button
          type="button"
          onClick={() => setThemeOpen((v) => !v)}
          className="focus-ring flex w-full items-center justify-between rounded-xl px-3 py-2 text-xs font-semibold uppercase tracking-wider text-text-secondary/60 hover:text-text-secondary"
        >
          {t('nav.appearance')}
          <ChevronDown size={14} className={`transition-transform ${themeOpen ? 'rotate-180' : ''}`} />
        </button>
        <AnimatePresence initial={false}>
          {themeOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <div className="flex flex-col gap-1 pt-1">
                {THEME_OPTIONS.map((option) => {
                  const active = preference === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setThemePreference(option.value)}
                      className={`focus-ring flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                        active
                          ? 'bg-accent/10 text-accent shadow-sm ring-1 ring-accent/15'
                          : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                      }`}
                    >
                      <span className="flex items-center gap-3">
                        <option.icon size={18} className={active ? 'text-accent' : 'text-text-secondary'} />
                        {label(option.label)}
                      </span>
                      {active && <Check size={16} className="text-accent" />}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
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
          <div className="flex items-center gap-1">
            <WhatsNewButton />
            <NotificationBell />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-text-secondary/60">
            {activeLabel}
          </p>
          {navContent}
        </div>
        <div className="border-t border-border px-3 py-4">
          <button
            type="button"
            onClick={handleSignOut}
            className="focus-ring flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <LogOut size={18} />
            {t('nav.signOut')}
          </button>
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
            <WhatsNewButton />
            <NotificationBell />
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label={t('nav.openMenu')}
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
            initial={{ x: isRtl ? '100%' : '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: isRtl ? '100%' : '-100%' }}
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
                  aria-label={t('nav.closeMenu')}
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
                  {t('nav.signOut')}
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
  const { i18n } = useTranslation('dashboard');
  return (
    // NotificationsProvider wraps everything here (not just <DashboardNav>)
    // because DashboardNav itself renders TWO <NotificationBell /> instances
    // at once (desktop sidebar + mobile header — CSS just hides one of
    // them, both stay mounted). One provider = one realtime subscription
    // shared by both bells, instead of each opening its own and colliding.
    // See NotificationsContext.tsx for the full story on the bug this fixes.
        <NotificationsProvider>
        <ChatUnreadProvider>
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
            <div key={i18n.language} className="contents">
  {children}
</div>
          </main>
        </div>
        <div className="no-print">
        <TaskReminderWatcher />
          <GlobalSearchPalette />
          <AiAssistant />
        </div>
      </div>
    </ChatUnreadProvider>
    </WhatsNewProvider>
    </NotificationsProvider>
  );
}
