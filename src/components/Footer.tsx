import { Mail, Linkedin, Phone, Facebook, Instagram } from 'lucide-react';
import { Link } from 'react-router-dom';
import { SARAH_PHONE } from '@/lib/site';

function RedditIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0Zm5.01 4.744c.688 0 1.25.561 1.25 1.252a1.25 1.25 0 0 1-2.498.015l-2.826-.6a.5.5 0 0 0-.598.348l-1.02 3.06c1.872.07 3.567.646 4.842 1.562.5-.4 1.146-.642 1.85-.642 1.657 0 3 1.343 3 3 0 1.194-.7 2.224-1.71 2.715-.04 3.06-3.42 5.523-7.5 5.523s-7.46-2.464-7.5-5.523C6.7 15.224 6 14.194 6 13c0-1.657 1.343-3 3-3 .704 0 1.35.242 1.85.642 1.275-.916 2.97-1.492 4.842-1.562l-1.02-3.06a.5.5 0 0 0-.598-.348l-2.826.6a1.25 1.25 0 1 1-.04-.348l3.116-.66a1 1 0 0 1 1.196-.696l3.05.646c.18-.46.63-.78 1.158-.78ZM9 13.25a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm6 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm-3.012 4.146c-.73 0-1.456.062-2.146.18a.375.375 0 1 0 .116.74c1.27-.2 2.79-.2 4.06 0a.375.375 0 1 0 .116-.74c-.69-.118-1.416-.18-2.146-.18Z" />
    </svg>
  );
}

const SOCIAL_LINKS = [
  { label: 'Vireek on Facebook', href: 'https://www.facebook.com/profile.php?id=61591755299005', Icon: Facebook },
  { label: 'Vireek on Instagram', href: 'https://www.instagram.com/vireek.ai/', Icon: Instagram },
  { label: 'Vireek on Reddit', href: 'https://www.reddit.com/user/Livid_Upstairs5570/', Icon: RedditIcon },
  { label: 'Vireek on LinkedIn', href: 'https://www.linkedin.com/in/ali-moradi-741346339', Icon: Linkedin },
];

const NAV_LINKS = [
  { label: 'Features', href: '/features' },
  { label: 'Platform', href: '/platform' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Compare', href: '/compare' },
  { label: 'FAQ', href: '/faq' },
  { label: 'About', href: '/about' },
  { label: 'Contact', href: '/contact' },
  { label: 'Privacy', href: '/privacy' },
  { label: 'Terms', href: '/terms' },
];

const EMAIL = 'ali@vireek.com';
const PHONE_DISPLAY = '+1 (650) 910-6703';

export function Footer() {
  return (
    <footer className="border-t border-border bg-bg-tertiary">
      <div className="mx-auto max-w-7xl px-6 py-16">
        <div className="grid gap-12 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
          {/* Brand */}
          <div className="max-w-sm">
            <span className="text-xl font-bold tracking-tight text-accent">Vireek</span>
            <p className="mt-4 text-sm leading-relaxed text-text-secondary">
              An AI voice receptionist for home-service businesses. Sarah answers every call, 24/7,
              so you never lose a job to voicemail.
            </p>
            <div className="mt-6 flex items-center gap-3">
              <a
                href={`mailto:${EMAIL}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Email ${EMAIL}`}
                className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:text-accent"
              >
                <Mail size={18} />
              </a>
              {SOCIAL_LINKS.map(({ label, href, Icon }) => (
                <a
                  key={href}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:text-accent"
                >
                  <Icon size={18} />
                </a>
              ))}
            </div>
          </div>

          {/* Navigation links */}
          <div className="md:col-span-2">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-text-primary">
              Navigate
            </h3>
            <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {NAV_LINKS.map((link) => {
                const isRoute = link.href.startsWith('/') && !link.href.includes('#');
                return (
                  <li key={link.href}>
                    {isRoute ? (
                      <Link
                        to={link.href}
                        className="focus-ring rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
                      >
                        {link.label}
                      </Link>
                    ) : (
                      <a
                        href={link.href}
                        className="focus-ring rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
                      >
                        {link.label}
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-text-primary">
              Contact
            </h3>
            <ul className="mt-4 flex flex-col gap-3">
              <li>
                <a
                  href={`mailto:${EMAIL}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="focus-ring inline-flex items-center gap-2 rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
                >
                  <Mail size={16} className="shrink-0 text-accent" />
                  {EMAIL}
                </a>
              </li>
              <li>
                <a
                  href={SARAH_PHONE}
                  className="focus-ring inline-flex items-center gap-2 rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
                >
                  <Phone size={16} className="shrink-0 text-accent" />
                  {PHONE_DISPLAY}
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-border pt-8 sm:flex-row">
          <p className="text-sm text-text-secondary">© 2026 Vireek. All rights reserved.</p>
          <div className="flex items-center gap-6">
            <Link
              to="/privacy"
              className="focus-ring rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Privacy Policy
            </Link>
            <span className="text-text-secondary/30">|</span>
            <Link
              to="/terms"
              className="focus-ring rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Terms of Service
            </Link>
            <span className="text-text-secondary/30">|</span>
            <a
              href={`mailto:${EMAIL}`}
              className="focus-ring rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Contact
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
