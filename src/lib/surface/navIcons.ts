import type { LucideIcon } from 'lucide-react';
import {
  AlertOctagon, AudioLines, Award, BadgeCheck, Banknote, BookOpen, Briefcase, ClipboardCheck, Coins, Crosshair, Eye, FileCheck2, FileClock, FileSearch, FileText, Gauge, Gavel, GitMerge, Handshake, HeartPulse, Landmark, Library, ListChecks, Lock, Mail, MapPinned, Medal, MessageSquareText, Microscope, Percent, PhoneMissed, PiggyBank, Radar, Receipt, RefreshCw, Rocket, RotateCcw, Route, SearchCheck, Store, Tags, Telescope, Timer, UserMinus, Webhook,
} from 'lucide-react';

/**
 * Icon overrides for menu rows whose original icon was shared with a sibling in the SAME hub, which made two
 * different pages look identical at a glance. Keyed by href so the nav item definitions stay untouched;
 * routes, labels, permissions and hub placement are not affected. Verified: no two rows of the same hub share an
 * icon after these overrides (the one exception is the two separate "Install Closeout" entries).
 */
export const NAV_ICON_OVERRIDES: Readonly<Record<string, LucideIcon>> = {
  '/dashboard/live-copilot': AudioLines,
  '/dashboard/call-queue': ListChecks,
  '/dashboard/power-dialer': Timer,
  '/dashboard/phone-numbers/reputation': BadgeCheck,
  '/dashboard/vehicles': Route,
  '/dashboard/card-feed': Receipt,
  '/dashboard/supplier-catalog': Library,
  '/dashboard/supplier-intelligence': Telescope,
  '/dashboard/recalls': AlertOctagon,
  '/dashboard/location-privacy': Lock,
  '/dashboard/permit-intelligence': FileSearch,
  '/dashboard/apprenticeship': Award,
  '/dashboard/technician-performance': Medal,
  '/dashboard/home-health': Gauge,
  '/dashboard/diagnosis-copilot': Microscope,
  '/dashboard/property-intelligence': MapPinned,
  '/dashboard/tags': Tags,
  '/dashboard/home-passport/pilot': FileCheck2,
  '/dashboard/job-summaries': FileClock,
  '/dashboard/inspection-reports': SearchCheck,
  '/dashboard/service-catalog': Library,
  '/dashboard/payments': Coins,
  '/dashboard/financing': PiggyBank,
  '/dashboard/financing/partners': Handshake,
  '/dashboard/hidden-technician': UserMinus,
  '/dashboard/payroll': Briefcase,
  '/dashboard/multi-entity': GitMerge,
  '/dashboard/expenses': Banknote,
  '/dashboard/lead-marketplaces': Store,
  '/dashboard/work-order-guard': ClipboardCheck,
  '/dashboard/margin-guardrails': Percent,
  '/dashboard/quote-truth': FileSearch,
  '/dashboard/reviews': MessageSquareText,
  '/dashboard/geo-grid': Radar,
  '/dashboard/direct-mail': Mail,
  '/dashboard/service-guarantee': BadgeCheck,
  '/dashboard/recovery': RotateCcw,
  '/dashboard/reports/executive': FileText,
  '/dashboard/results-plan': ListChecks,
  '/dashboard/pilot-results': Rocket,
  '/dashboard/outcome-benchmarks': Crosshair,
  '/dashboard/help': BookOpen,
  '/dashboard/settings/trust-badge': BadgeCheck,
  '/dashboard/payroll-sync': RefreshCw,
  '/dashboard/sage-intacct': Landmark,
  '/dashboard/webhook-deliveries': Webhook,
  '/dashboard/agent-governance': Gavel,
  '/dashboard/ai-reliability': HeartPulse,
  '/dashboard/voice-resilience': PhoneMissed,
  '/dashboard/site-safety': Eye,
  '/dashboard/capacity-guard': Gauge,
  '/dashboard/revenue-radar': Crosshair,
};

/** The icon to draw for a menu row: the override when one exists, otherwise the item's own icon. */
export function navIcon<T extends LucideIcon>(href: string, fallback: T): LucideIcon {
  return NAV_ICON_OVERRIDES[href] ?? fallback;
}
