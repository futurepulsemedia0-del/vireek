import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Menu, X } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { ThemeToggle } from '@/components/ThemeToggle';
import { NAV_LINKS } from '@/lib/site';
import { useTheme } from '@/contexts/ThemeContext';

function Logo({ mobile = false }: { mobile?: boolean }) {
  const { theme } = useTheme();
  const size = mobile ? 'h-10 w-10' : 'h-12 w-12';

  return (
    <span className={`relative block shrink-0 ${size}`}>
      <img
        src="/assets/logos/logo-dark.png.png"
        alt="Vireek"
        className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${
          theme === 'light' ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <img
        src="/assets/logos/logo-light.png.png"
        alt=""
        aria-hidden="true"
        className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${
          theme === 'dark' ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </span>
  );
}

function NavLink({ label, href, onClick }: { label: string; href: string; onClick?: () => void }) {
  return (
    <a
      href={href}
      onClick={onClick}
      className="focus-ring group relative rounded-md px-1 py-1 text-sm font-medium text-text-secondary transition-colors duration-150 hover:text-text-primary"
    >
      {label}
      <span className="absolute -bottom-0.5 left-1/2 h-px w-0 -translate-x-1/2 bg-accent transition-all duration-200 ease-out group-hover:w-[calc(100%-0.25rem)]" />
    </a>
  );
}

export function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const isHome = location.pathname === '/';

  const navHref = (href: string) => {
    if (href.startsWith('/')) return href;
    return isHome ? href : `/${href}`;
  };

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (drawerOpen) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [drawerOpen]);

  return (
    <>
      <header
        className={`fixed inset-x-0 top-0 z-50 transition-all duration-200 ease-out ${
          scrolled
            ? 'border-b border-border/80 bg-bg-secondary/85 shadow-sm backdrop-blur-xl'
            : 'border-b border-transparent bg-transparent'
        }`}
      >
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-3">
            <Logo />
            <span className="text-lg font-bold tracking-tight text-text-primary">Vireek</span>
          </Link>

          <nav className="hidden items-center gap-8 md:flex">
            {NAV_LINKS.map((link) => (
              <NavLink key={link.href} label={link.label} href={navHref(link.href)} />
            ))}
          </nav>

          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link to="/login" className="hidden sm:block">
              <Button variant="primary" size="sm">
                Start Free Trial
              </Button>
            </Link>
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-primary md:hidden"
            >
              <Menu size={18} />
            </button>
          </div>
        </div>
      </header>

      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setDrawerOpen(false)}
              className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-sm md:hidden"
            />
            <motion.aside
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="fixed right-0 top-0 z-50 flex h-full w-80 max-w-[85vw] flex-col gap-2 border-l border-border bg-bg-secondary p-6 md:hidden"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Logo mobile />
                  <span className="text-lg font-bold tracking-tight text-text-primary">Vireek</span>
                </div>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close menu"
                  className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border text-text-secondary hover:text-text-primary"
                >
                  <X size={18} />
                </button>
              </div>
              <nav className="mt-6 flex flex-col gap-1">
                {NAV_LINKS.map((link) => (
                  <a
                    key={link.href}
                    href={navHref(link.href)}
                    onClick={() => setDrawerOpen(false)}
                    className="focus-ring rounded-lg px-3 py-3 text-base font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                  >
                    {link.label}
                  </a>
                ))}
              </nav>
              <Link to="/login" className="mt-auto">
                <Button variant="primary" size="md" className="w-full">
                  Start Free Trial
                </Button>
              </Link>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
