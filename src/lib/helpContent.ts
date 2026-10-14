import {
  Rocket,
  PhoneCall,
  LayoutDashboard,
  Users,
  CreditCard,
  Plug,
  Bell,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export interface HelpArticle {
  q: string;
  a: string;
  /** Optional stable URL slug. Set it once an article is live so editing the question never changes its URL. */
  slug?: string;
}

export interface HelpCategory {
  id: string;
  name: string;
  icon: LucideIcon;
  description: string;
  articles: HelpArticle[];
}

export const HELP_CATEGORIES: HelpCategory[] = [
  // ← paste the existing category objects here (everything between the original [ and ])
];
