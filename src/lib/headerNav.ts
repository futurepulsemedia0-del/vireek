import {
  Activity,
  BookOpen,
  Braces,
  Briefcase,
  Building2,
  Calculator,
  FileText,
  FlaskConical,
  GraduationCap,
  HelpCircle,
  History,
  Layers,
  LifeBuoy,
  Lock,
  MessageCircle,
  MessagesSquare,
  Mic,
  Newspaper,
  Phone,
  PhoneForwarded,
  Plug,
  Quote,
  Rocket,
  Scale,
  ShieldCheck,
  Sparkles,
  Star,
  Store,
  Tag,
  Terminal,
  TrendingUp,
  Users,
  Video,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { INDUSTRIES } from '@/lib/industries';
import { SARAH_PHONE } from '@/lib/site';

export interface MegaLink {
  label: string;
  href: string;
  description?: string;
  icon?: LucideIcon;
}

export interface MegaGroup {
  title: string;
  links: MegaLink[];
  /** Dense rows (label only) — used for long lists such as industries and competitors. */
  compact?: boolean;
}

export interface MegaFeatured {
  eyebrow: string;
  title: string;
  description: string;
  cta: { label: string; href: string };
  icon: LucideIcon;
}

export interface MegaPanel {
  /** 1–3 groups. */
  groups: MegaGroup[];
  featured?: MegaFeatured;
  overview: { label: string; href: string };
}

export interface NavItem {
  id: string;
  href: string;
  /** Existing i18n key (every locale already has it). */
  labelKey: string;
  /** Extra path prefixes that should mark this item as the active one. */
  activePrefixes?: string[];
  /** Leading icon, shown on the top-level rows of the mobile menu. */
  icon?: LucideIcon;
  panel?: MegaPanel;
}

const industryLink = (i: (typeof INDUSTRIES)[number]): MegaLink => ({
  label: i.name,
  href: `/industries/${i.slug}`,
  icon: i.icon,
});

const vs = (label: string, slug: string): MegaLink => ({ label, href: `/compare/${slug}`, icon: Scale });

export const NAV_ITEMS: NavItem[] = [
  {
    id: 'sarah',
    href: '/features',
    labelKey: 'nav.features',
    icon: Sparkles,
    panel: {
      overview: { label: 'See all features', href: '/features' },
      groups: [
        {
          title: 'What Sarah does',
          links: [
            { label: 'Lead Qualification', href: '/features/lead-qualification', icon: Users, description: 'Screen every caller before they reach your team.' },
            { label: 'SMS Text-Back', href: '/features/sms-text-back', icon: MessageCircle, description: 'Reply to missed calls by text, instantly.' },
            { label: 'WhatsApp & Instagram DMs', href: '/features/whatsapp-instagram-dm', icon: Sparkles, description: 'Answer customer messages in the apps they use.' },
            { label: 'Live Escalation', href: '/features/live-escalation', icon: PhoneForwarded, description: 'Hand urgent calls to a real person.' },
          ],
        },
        {
          title: 'See it in action',
          links: [
            { label: 'Book a Demo', href: '/demo', icon: Mic, description: 'A guided walkthrough for your business.' },
            { label: 'Revenue Calculator', href: '/calculator', icon: Calculator, description: 'What missed calls cost you each month.' },
            { label: 'Customer Stories', href: '/customers', icon: Star, description: 'How other contractors use Sarah.' },
          ],
        },
      ],
      featured: {
        eyebrow: 'Live demo',
        title: 'Hear Sarah answer a real call',
        description: 'A real, live conversation — no signup required.',
        cta: { label: 'Talk to Sarah', href: SARAH_PHONE },
        icon: Phone,
      },
    },
  },
  {
    id: 'platform',
    href: '/platform',
    labelKey: 'nav.platform',
    icon: Layers,
    activePrefixes: ['/integrations', '/marketplace', '/docs', '/sdks', '/sandbox', '/developers', '/security', '/trust', '/enterprise', '/onboarding-guide'],
    panel: {
      overview: { label: 'See how it works', href: '/platform' },
      groups: [
        {
          title: 'Platform',
          links: [
            { label: 'How It Works', href: '/platform', icon: Workflow, description: 'From the first ring to a booked job.' },
            { label: 'Integrations', href: '/integrations', icon: Plug, description: 'Connect the tools you already use.' },
            { label: 'Marketplace', href: '/marketplace', icon: Store, description: 'Extend Vireek with add-ons.' },
            { label: 'Onboarding Guide', href: '/onboarding-guide', icon: Rocket, description: 'Get set up step by step.' },
          ],
        },
        {
          title: 'Developers',
          links: [
            { label: 'Developer Docs', href: '/docs', icon: BookOpen, description: 'Endpoints and scopes for calls and leads.' },
            { label: 'API Reference', href: '/developers/api-reference', icon: Braces, description: 'OpenAPI spec, Postman collection, live playground.' },
            { label: 'SDKs (Node.js & Python)', href: '/sdks', icon: Terminal, description: 'Official client libraries for Node.js and Python.' },
            { label: 'Sandbox', href: '/sandbox', icon: FlaskConical, description: 'Test integrations with synthetic webhook payloads.' },
            { label: 'Developer Changelog', href: '/developers/changelog', icon: History, description: 'Release notes for the API, SDKs and webhooks.' },
          ],
        },
        {
          title: 'Trust & security',
          links: [
            { label: 'Security', href: '/security', icon: ShieldCheck, description: 'Encryption, account isolation and role-based access.' },
            { label: 'Trust Center', href: '/trust', icon: Lock, description: 'Data handling, sub-processors and compliance docs.' },
            { label: 'Enterprise', href: '/enterprise', icon: Building2, description: 'Custom seats, locations, SLA and dedicated onboarding.' },
          ],
        },
      ],
    },
  },
  {
    id: 'industries',
    href: '/industries',
    labelKey: 'nav.industries',
    icon: Briefcase,
    panel: {
      overview: { label: 'See all industries', href: '/industries' },
      groups: [
        { title: 'Core trades', compact: true, links: INDUSTRIES.slice(0, 6).map(industryLink) },
        { title: 'More trades', compact: true, links: INDUSTRIES.slice(6).map(industryLink) },
      ],
      featured: {
        eyebrow: 'Revenue calculator',
        title: 'What do missed calls cost you?',
        description: 'Plug in your own numbers and see it in under a minute.',
        cta: { label: 'Open calculator', href: '/calculator' },
        icon: Calculator,
      },
    },
  },
  { id: 'pricing', href: '/pricing', labelKey: 'nav.pricing', icon: Tag },
  {
    id: 'compare',
    href: '/compare',
    labelKey: 'nav.compare',
    icon: Scale,
    activePrefixes: ['/switch'],
    panel: {
      overview: { label: 'Compare all tools', href: '/compare' },
      groups: [
        {
          title: 'Field-service software',
          compact: true,
          links: [
            vs('ServiceTitan', 'servicetitan'),
            vs('Housecall Pro', 'housecall-pro'),
            vs('Jobber', 'jobber'),
            vs('FieldRoutes', 'fieldroutes'),
            vs('Service Fusion', 'service-fusion'),
            vs('Workiz', 'workiz'),
          ],
        },
        {
          title: 'AI & answering services',
          compact: true,
          links: [
            vs('Answering Service', 'answering-service'),
            vs('Avoca AI', 'avoca-ai'),
            vs('Sameday AI', 'sameday-ai'),
            vs('Smith.ai', 'smith-ai'),
            vs('Podium', 'podium'),
            vs('Numa', 'numa'),
            vs('Goodcall', 'goodcall'),
            vs('Rosie & My AI Front Desk', 'rosie-my-ai-front-desk'),
            vs('Dialzara', 'dialzara'),
            vs('Ruby Receptionists', 'ruby-receptionists'),
          ],
        },
        {
          title: 'Switching',
          links: [
            { label: 'Full Feature Matrix', href: '/compare/matrix', icon: Workflow, description: 'Every feature, side by side.' },
            { label: 'Switch Guides', href: '/switch', icon: Rocket, description: 'Move over from your current tool.' },
            { label: 'Revenue Calculator', href: '/calculator', icon: Calculator, description: 'See the cost of missed calls.' },
          ],
        },
      ],
    },
  },
  {
    id: 'resources',
    href: '/resources',
    labelKey: 'footer.resources',
    icon: BookOpen,
    activePrefixes: ['/blog', '/faq', '/customers', '/case-studies', '/academy', '/podcast', '/glossary', '/webinars', '/help', '/community', '/changelog', '/report', '/roi', '/testimonials', '/status'],
    panel: {
      overview: { label: 'Browse all resources', href: '/resources' },
      groups: [
        {
          title: 'Learn',
          links: [
            { label: 'Blog', href: '/blog', icon: Newspaper, description: 'Guides on missed calls, scripts and dispatch.' },
            { label: 'Podcast', href: '/podcast', icon: Mic, description: 'Conversations with home-service owners. Coming soon.' },
            { label: 'Academy', href: '/academy', icon: GraduationCap, description: 'Self-paced lessons with a completion certificate.' },
            { label: 'Glossary', href: '/glossary', icon: BookOpen, description: 'AI voice and trade terms in plain language.' },
            { label: 'Webinars & Events', href: '/webinars', icon: Video, description: 'A 30-minute walkthrough with live Q&A.' },
          ],
        },
        {
          title: 'Proof',
          links: [
            { label: 'Customer Stories', href: '/customers', icon: Star, description: 'How other contractors use Sarah.' },
            { label: 'Case Studies', href: '/case-studies', icon: FileText, description: 'Missed calls recovered and revenue saved.' },
            { label: 'Customer ROI', href: '/roi', icon: TrendingUp, description: 'Verified revenue recovered by real customers.' },
            { label: 'Testimonials', href: '/testimonials', icon: Quote, description: 'Quotes from early-access contractors.' },
          ],
        },
        {
          title: 'Support',
          links: [
            { label: 'Help Center', href: '/help', icon: LifeBuoy, description: 'Setup, billing, integrations and troubleshooting.' },
            { label: 'FAQ', href: '/faq', icon: HelpCircle, description: 'The essentials about Vireek, answered.' },
            { label: 'Community', href: '/community', icon: MessagesSquare, description: 'Talk with other home-service owners.' },
            { label: 'Changelog', href: '/changelog', icon: History, description: 'New features, improvements and security updates.' },
            { label: 'Status', href: '/status', icon: Activity, description: 'Service health for calls, dashboard and alerts.' },
          ],
        },
      ],
      featured: {
        eyebrow: 'Report',
        title: 'State of Home Service Calls',
        description: 'Our report on how home-service businesses handle inbound calls.',
        cta: { label: 'Read the report', href: '/report' },
        icon: Newspaper,
      },
    },
  },
];

/** True when the current path belongs to this top-level item. */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  return [item.href, ...(item.activePrefixes ?? [])].some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/** Internal route (client-side <Link>) vs tel:/mailto:/https: (plain <a>). */
export const isInternalHref = (href: string): boolean => href.startsWith('/');
