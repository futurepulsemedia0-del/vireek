import { useEffect, useState, useRef, useCallback } from 'react';
import { AnimatePresence, motion, useScroll, useSpring } from 'framer-motion';
import { Link, useLocation } from 'react-router-dom';
import { LogIn, ArrowRight, ChevronDown, Wind, Droplets, Home, Zap, Flame } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { NAV_LINKS } from '@/lib/site';
import { useTheme } from '@/contexts/ThemeContext';
import { INDUSTRIES } from '@/lib/industries';

/* ------------------------------------------------------------------ */
/*  Logo                                                               */
/* ------------------------------------------------------------------ */

function Logo({ size = 'h-9 w-9' }: { size?: string }) {
  const { theme } = useTheme();
  return (
    <span className={`relative block shrink-0 ${size}`}>
      <img
        src="/assets/logos/logo-dark.png.png"
        alt="Vireek"
        width={36}
        height={36}
        decoding="async"
        loading="eager"
        className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${
          theme === 'light' ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <img
        src="/assets/logos/logo-light.png.png"
        alt=""
        aria-hidden="true"
        width={36}
        height={36}
        decoding="async"
        loading="eager"
        className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${
          theme === 'dark' ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Industries dropdown data                                           */
/* ------------------------------------------------------------------ */

const INDUSTRY_ITEMS = INDUSTRIES.map((ind) => ({
  label: ind.name,
  href: `/industries/${ind.slug}`,
  icon: ind.icon,
  tagline: ind.tagline,
}));

const DROPDOWN_MAP: Record<string, typeof INDUSTRY_ITEMS> = {
  Industries: INDUSTRY_ITEMS,
};

/* ------------------------------------------------------------------ */
/*  Desktop nav link with dropdown                                     */
/* ------------------------------------------------------------------ */

function DesktopNavLink({ link, isActive }: { link: { label: string; href: string }; isActive: boolean }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isRoute = link.href.startsWith('/') && !link.href.includes('#');
  const dropdown = DROPDOWN_MAP[link.label];

  const onEnter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const onLeave = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };

  const linkClass = `group relative rounded-md px-1 py-1.5 text-[0.8125rem] font-medium transition-colors duration-150 ${
    isActive
      ? 'text-text-primary'
      : 'text-text-secondary hover:text-text-primary'
  }`;

  const inner = (
    <span className="relative flex items-center gap-0.5">
      {link.label}
      {dropdown && (
        <ChevronDown
          size={13}
          className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      )}
      <span
        className={`absolute -bottom-0.5 left-0 h-px bg-accent transition-all duration-200 ease-out ${
          isActive || open
            ? 'w-full'
            : 'w-0 group-hover:w-full'
        }`}
      />
    </span>
  );

  return (
    <div className="relative" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {isRoute ? (
        <Link to={link.href} className={linkClass}>
          {inner}
        </Link>
      ) : (
        <a href={link.href} className={linkClass}>
          {inner}
        </a>
      )}

      {/* Dropdown */}
      <AnimatePresence>
        {dropdown && open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="absolute left-1/2 top-full z-50 mt-3 -translate-x-1/2"
          >
            {/* Invisible bridge to prevent hover gap */}
            <div className="absolute inset-x-0 -top-3 h-3" />
            <div className="w-[340px] overflow-hidden rounded-2xl border border-border/70 bg-bg-secondary/95 p-2 shadow-2xl backdrop-blur-xl">
              {dropdown.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    to={item.href}
                    className="group flex items-start gap-3 rounded-xl p-3 transition-colors duration-150 hover:bg-bg-tertiary"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/20 bg-accent/10 text-accent transition-colors group-hover:border-accent/40 group-hover:bg-accent/15">
                      <Icon size={17} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-text-primary">{item.label}</p>
                      <p className="mt-0.5 text-xs leading-snug text-text-secondary line-clamp-1">
                        {item.tagline}
                      </p>
                    </div>
                    <ArrowRight
                      size={14}
                      className="mt-1 shrink-0 text-text-secondary/30 transition-all group-hover:translate-x-0.5 group-hover:text-accent"
                    />
                  </Link>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Animated hamburger button                                          */
/* ------------------------------------------------------------------ */

function HamburgerButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={open ? 'Close menu' : 'Open menu'}
      aria-expanded={open}
      className="focus-ring relative flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary/80 text-text-primary transition-colors hover:bg-bg-tertiary md:hidden"
    >
      <div className="relative flex h-4 w-5 flex-col justify-between">
        <motion.span
          animate={open ? { rotate: 45, y: 7 } : { rotate: 0, y: 0 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="block h-0.5 w-5 rounded-full bg-current"
        />
        <motion.span
          animate={open ? { opacity: 0, scaleX: 0 } : { opacity: 1, scaleX: 1 }}
          transition={{ duration: 0.15 }}
          className="block h-0.5 w-5 rounded-full bg-current"
        />
        <motion.span
          animate={open ? { rotate: -45, y: -7 } : { rotate: 0, y: 0 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="block h-0.5 w-5 rounded-full bg-current"
        />
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Main header                                                         */
/* ------------------------------------------------------------------ */

export function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const { scrollYProgress } = useScroll();
  const scrollProgress = useSpring(scrollYProgress, {
    stiffness: 280,
    damping: 40,
    mass: 0.3,
  });

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [drawerOpen]);

  // Close drawer on route change
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Escape to close drawer
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const isActive = useCallback(
    (href: string) => {
      if (href === '/industries/hvac') {
        return location.pathname.startsWith('/industries');
      }
      return location.pathname === href;
    },
    [location.pathname]
  );

  return (
    <>
      {/* Scroll progress bar */}
      <motion.div
        aria-hidden="true"
        style={{ scaleX: scrollProgress }}
        className="scroll-progress fixed inset-x-0 top-0 z-[60] h-0.5 origin-left bg-accent"
      />

      {/* Floating header */}
      <motion.header
        initial={{ y: -24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="fixed inset-x-0 top-0 z-50"
      >
        <div className="mx-auto max-w-7xl px-4 pt-3 sm:px-6 sm:pt-4">
          <div
            className={`flex items-center justify-between rounded-2xl px-4 py-2.5 transition-all duration-300 ease-out sm:px-5 sm:py-3 ${
              scrolled
                ? 'border border-border/70 bg-bg-secondary/80 shadow-lg shadow-slate-950/5 backdrop-blur-xl'
                : 'border border-transparent bg-transparent'
            }`}
          >
            {/* Logo */}
            <Link to="/" className="flex items-center gap-2.5" aria-label="Vireek home">
              <Logo />
              <span className="text-base font-bold tracking-tight text-text-primary">Vireek</span>
            </Link>

            {/* Desktop nav */}
            <nav className="hidden items-center gap-7 md:flex">
              {NAV_LINKS.map((link) => (
                <DesktopNavLink
                  key={link.href}
                  link={link}
                  isActive={isActive(link.href)}
                />
              ))}
            </nav>

            {/* Right side */}
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="hidden sm:block">
                <ThemeToggle />
              </div>
              <Link
                to="/login"
                className="focus-ring hidden items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-text-secondary transition-all duration-150 hover:bg-bg-tertiary hover:text-text-primary md:flex"
              >
                <LogIn size={15} />
                Log In
              </Link>
              <Link to="/login" className="hidden md:block">
                <button
                  type="button"
                  className="focus-ring group relative flex h-9 items-center gap-1.5 overflow-hidden rounded-xl bg-accent px-4 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:shadow-glow-accent active:scale-[0.97]"
                >
                  <span className="relative z-10">Start Free Trial</span>
                  <ArrowRight
                    size={15}
                    className="relative z-10 transition-transform duration-200 group-hover:translate-x-0.5"
                  />
                  {/* Shimmer on hover */}
                  <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-500 group-hover:translate-x-full" />
                </button>
              </Link>

              {/* Mobile theme toggle */}
              <div className="sm:hidden">
                <ThemeToggle />
              </div>

              {/* Hamburger */}
              <HamburgerButton open={drawerOpen} onClick={() => setDrawerOpen((v) => !v)} />
            </div>
          </div>
        </div>
      </motion.header>

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
              className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-sm md:hidden"
            />
            <motion.aside
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="fixed right-0 top-0 z-50 flex h-full w-80 max-w-[85vw] flex-col border-l border-border bg-bg-secondary md:hidden"
            >
              {/* Drawer header */}
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <Link to="/" className="flex items-center gap-2.5" onClick={() => setDrawerOpen(false)}>
                  <Logo size="h-8 w-8" />
                  <span className="text-base font-bold tracking-tight text-text-primary">Vireek</span>
                </Link>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close menu"
                  className="focus-ring flex h-9 w-9 items-center justify-center rounded-xl border border-border text-text-secondary transition-colors hover:text-text-primary"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              </div>

              {/* Nav links */}
              <nav className="flex-1 overflow-y-auto px-3 py-4">
                {NAV_LINKS.map((link, i) => {
                  const isRoute = link.href.startsWith('/') && !link.href.includes('#');
                  const active = isActive(link.href);
                  const dropdown = DROPDOWN_MAP[link.label];
                  const className = `focus-ring flex items-center justify-between rounded-xl px-3 py-3 text-base font-medium transition-colors ${
                    active
                      ? 'bg-accent/10 text-accent'
                      : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                  }`;

                  return (
                    <motion.div
                      key={link.href}
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.05 + i * 0.04, duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                    >
                      {isRoute ? (
                        <Link to={link.href} onClick={() => setDrawerOpen(false)} className={className}>
                          {link.label}
                          {dropdown && <ChevronDown size={16} className="rotate-0" />}
                        </Link>
                      ) : (
                        <a href={link.href} onClick={() => setDrawerOpen(false)} className={className}>
                          {link.label}
                        </a>
                      )}

                      {/* Inline industry items in drawer */}
                      {dropdown && (
                        <div className="ml-3 mt-1 space-y-0.5 border-l border-border pl-3">
                          {dropdown.map((item) => {
                            const Icon = item.icon;
                            return (
                              <Link
                                key={item.href}
                                to={item.href}
                                onClick={() => setDrawerOpen(false)}
                                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                              >
                                <Icon size={15} className="shrink-0 text-accent/70" />
                                {item.label}
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </nav>

              {/* Drawer footer */}
              <div className="space-y-2 border-t border-border px-5 py-4">
                <Link
                  to="/login"
                  onClick={() => setDrawerOpen(false)}
                  className="focus-ring flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-border bg-bg-tertiary text-sm font-semibold text-text-primary transition-colors hover:bg-bg-tertiary/80"
                >
                  <LogIn size={16} />
                  Log In
                </Link>
                <Link
                  to="/login"
                  onClick={() => setDrawerOpen(false)}
                  className="focus-ring group flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent text-sm font-semibold text-white shadow-sm transition-all hover:shadow-glow-accent active:scale-[0.98]"
                >
                  Start Free Trial
                  <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
