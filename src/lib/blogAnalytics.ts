import { trackEvent } from '@/lib/analytics';

/** Blog analytics. trackEvent() is consent-gated: nothing is sent unless analytics cookies are accepted. */
export const blogEvents = {
  scrollDepth: (slug: string, percent: number) => trackEvent('blog_scroll_depth', { post_slug: slug, percent }),
  ctaClick: (slug: string, ctaType: string, placement: 'inline' | 'end') =>
    trackEvent('blog_cta_click', { post_slug: slug, cta_type: ctaType, placement }),
  calculatorUse: (slug: string) => trackEvent('blog_calculator_use', { post_slug: slug }),
  newsletterSignup: (source: string) => trackEvent('blog_newsletter_signup', { source }),
  share: (slug: string, channel: string) => trackEvent('blog_share', { post_slug: slug, channel }),
};

export const SCROLL_MILESTONES = [25, 50, 75, 90] as const;
