import {
  Bot, Workflow, Plug, Scale, ShieldCheck, BookOpen, LifeBuoy, HelpCircle,
  Trophy, Calculator, History, PhoneCall, type LucideIcon,
} from 'lucide-react';
import { INDUSTRIES, type Industry } from '@/lib/industries';

export interface NavLeaf {
  readonly id: string;
  readonly href: string;
  readonly icon: LucideIcon;
  /** i18n keys for static content. */
  readonly labelKey?: string;
  readonly descKey?: string;
  /** Literal text for data-driven content (industries come from @/lib/industries). */
  readonly label?: string;
  readonly desc?: string;
}

export interface NavGroup {
  readonly id: string;
  readonly labelKey?: string;
  readonly items: readonly NavLeaf[];
}

export interface NavFeatured {
  readonly href: string;
  readonly icon: LucideIcon;
  readonly titleKey: string;
  readonly descKey: string;
  readonly ctaKey: string;
}

export interface NavMenu {
  readonly kind: 'menu';
  readonly id: string;
  readonly labelKey: string;
  readonly groups: readonly NavGroup[];
  readonly featured?: NavFeatured;
  readonly footer?: { readonly href: string; readonly labelKey: string };
}

export interface NavLink {
  readonly kind: 'link';
  readonly id: string;
  readonly labelKey: string;
  readonly href: string;
}

export type NavEntry = NavMenu | NavLink;

const leaf = (id: string, href: string, icon: LucideIcon): NavLeaf => ({
  id,
  href,
  icon,
  labelKey: `nav.item.${id}.title`,
  descKey: `nav.item.${id}.desc`,
});

const industryLeaf = (ind: Industry): NavLeaf => ({
  id: `industry-${ind.slug}`,
  href: `/industries/${ind.slug}`,
  icon: ind.icon,
  label: ind.name,
  desc: ind.tagline,
});

export const PUBLIC_NAV: readonly NavEntry[] = [
  {
    kind: 'menu',
    id: 'product',
    labelKey: 'nav.product',
    groups: [
      {
        id: 'platform',
        labelKey: 'nav.group.platform',
        items: [
          leaf('features', '/features', Bot),
          leaf('platform', '/platform', Workflow),
          leaf('integrations', '/integrations', Plug),
        ],
      },
      {
        id: 'evaluate',
        labelKey: 'nav.group.evaluate',
        items: [leaf('compare', '/compare', Scale), leaf('security', '/security', ShieldCheck)],
      },
    ],
    featured: {
      href: '/demo',
      icon: PhoneCall,
      titleKey: 'nav.featured.title',
      descKey: 'nav.featured.desc',
      ctaKey: 'cta.bookDemo',
    },
  },
  {
    kind: 'menu',
    id: 'solutions',
    labelKey: 'nav.solutions',
    groups: [
      { id: 'trades-a', items: INDUSTRIES.slice(0, 4).map(industryLeaf) },
      { id: 'trades-b', items: INDUSTRIES.slice(4, 8).map(industryLeaf) },
    ],
    footer: { href: '/industries', labelKey: 'nav.allIndustries' },
  },
  { kind: 'link', id: 'pricing', labelKey: 'nav.pricing', href: '/pricing' },
  {
    kind: 'menu',
    id: 'resources',
    labelKey: 'nav.resources',
    groups: [
      {
        id: 'learn',
        labelKey: 'nav.group.learn',
        items: [
          leaf('blog', '/blog', BookOpen),
          leaf('caseStudies', '/case-studies', Trophy),
          leaf('help', '/help', LifeBuoy),
          leaf('faq', '/faq', HelpCircle),
        ],
      },
      {
        id: 'tools',
        labelKey: 'nav.group.tools',
        items: [leaf('roi', '/roi', Calculator), leaf('changelog', '/changelog', History)],
      },
    ],
  },
  { kind: 'link', id: 'company', labelKey: 'nav.company', href: '/about' },
];

export function isHrefActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isEntryActive(pathname: string, entry: NavEntry): boolean {
  if (entry.kind === 'link') return isHrefActive(pathname, entry.href);
  const inGroups = entry.groups.some((g) => g.items.some((i) => isHrefActive(pathname, i.href)));
  return inGroups || (entry.footer ? isHrefActive(pathname, entry.footer.href) : false);
}

export function leafText(translate: (key: string) => string, item: NavLeaf): { title: string; desc: string } {
  return {
    title: item.labelKey ? translate(item.labelKey) : (item.label ?? ''),
    desc: item.descKey ? translate(item.descKey) : (item.desc ?? ''),
  };
}
