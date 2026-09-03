import { Mail, Linkedin, Phone } from 'lucide-react';
import { Link } from 'react-router-dom';
import { SARAH_PHONE } from '@/lib/site';

const NAV_LINKS = [
  { label: 'Home', href: '/' },
  { label: 'About', href: '/#about' },
  { label: 'Services', href: '/#features' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'FAQ', href: '/faq' },
  { label: 'Contact', href: '/#contact' },
  { label: 'Privacy', href: '/privacy' },
  { label: 'Terms', href: '/terms' },
];

const EMAIL = 'ali@vireek.com';
const LINKEDIN_URL = 'https://www.linkedin.com/in/ali-moradi-741346339';
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
                className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
              >
                <Mail size={18} />
              </a>
              <a
                href={LINKEDIN_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Vireek on LinkedIn"
                className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
              >
                <Linkedin size={18} />
              </a>
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
