import {
  Activity,
  BookOpen,
  Building2,
  Calculator,
  Code2,
  GraduationCap,
  LifeBuoy,
  Lock,
  MessageCircle,
  Mic,
  Newspaper,
  Phone,
  PhoneForwarded,
  Plug,
  Rocket,
  ShieldCheck,
  Sparkles,
  Star,
  Store,
  Users,
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
  panel?: MegaPanel;
}

const industryLink = (i: (typeof INDUSTRIES)[number]): MegaLink => ({
  label: i.name,
  href: `/industries/${i.slug}`,
  icon: i.icon,
});

const vs = (label: string, slug: string): MegaLink => ({ label, href: `/compare/${slug}` });

export const NAV_ITEMS: NavItem[] = [
  {
    id: 'sarah',
    href: '/features',
    labelKey: 'nav.features',
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
            { label: 'Developer Docs', href: '/docs', icon: BookOpen },
            { label: 'API Reference', href: '/developers/api-reference', icon: Code2 },
            { label: 'SDKs (Node.js & Python)', href: '/sdks', icon: Code2 },
            { label: 'Sandbox', href: '/sandbox', icon: Code2 },
            { label: 'Developer Changelog', href: '/developers/changelog', icon: Activity },
          ],
        },
        {
          title: 'Trust & security',
          links: [
            { label: 'Security', href: '/security', icon: ShieldCheck },
            { label: 'Trust Center', href: '/trust', icon: Lock },
            { label: 'Enterprise', href: '/enterprise', icon: Building2 },
          ],
        },
      ],
    },
  },
  {
    id: 'industries',
    href: '/industries',
    labelKey: 'nav.industries',
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
  { id: 'pricing', href: '/pricing', labelKey: 'nav.pricing' },
  {
    id: 'compare',
    href: '/compare',
    labelKey: 'nav.compare',
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
    activePrefixes: ['/blog', '/faq', '/customers', '/case-studies', '/academy', '/podcast', '/glossary', '/webinars', '/help', '/community', '/changelog', '/report', '/roi', '/testimonials', '/status'],
    panel: {
      overview: { label: 'Browse all resources', href: '/resources' },
      groups: [
        {
          title: 'Learn',
          compact: true,
          links: [
            { label: 'Blog', href: '/blog', icon: Newspaper },
            { label: 'Podcast', href: '/podcast', icon: Mic },
            { label: 'Academy', href: '/academy', icon: GraduationCap },
            { label: 'Glossary', href: '/glossary', icon: BookOpen },
            { label: 'Webinars & Events', href: '/webinars', icon: Users },
          ],
        },
        {
          title: 'Proof',
          compact: true,
          links: [
            { label: 'Customer Stories', href: '/customers', icon: Star },
            { label: 'Case Studies', href: '/case-studies', icon: BookOpen },
            { label: 'Customer ROI', href: '/roi', icon: Calculator },
            { label: 'Testimonials', href: '/testimonials', icon: Star },
          ],
        },
        {
          title: 'Support',
          compact: true,
          links: [
            { label: 'Help Center', href: '/help', icon: LifeBuoy },
            { label: 'FAQ', href: '/faq', icon: LifeBuoy },
            { label: 'Community', href: '/community', icon: Users },
            { label: 'Changelog', href: '/changelog', icon: Activity },
            { label: 'Status', href: '/status', icon: Activity },
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
