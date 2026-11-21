import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, useScroll, useSpring } from 'framer-motion';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, LayoutDashboard, LogIn, Phone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { useDirection } from '@/hooks/useDirection';
import { SARAH_PHONE } from '@/lib/site';
import { DesktopMegaNav } from '@/components/header/MegaMenu';
import { MobileNav } from '@/components/header/MobileNav';
import { Logo as BrandLogo } from '@/components/brand/Logo';

const EASE = [0.16, 1, 0.3, 1] as const;

/* ------------------------------------------------------------------ */
/*  Logo (mark + wordmark)                                             */
/* ------------------------------------------------------------------ */

function Logo({ px = 36 }: { px?: number }) {
  return <BrandLogo variant="tile" size={px} decorative />;
}

/* ------------------------------------------------------------------ */
/*  Auth-aware actions                                                 */
/* ------------------------------------------------------------------ */

// Tolerant of being rendered outside <AuthProvider> (tests, error fallbacks):
// useAuth() always runs useContext() before it throws, so hook order is stable.
function useIsSignedIn(): boolean {
  try {
    return Boolean(useAuth().user);
  } catch {
    return false;
  }
}

function DesktopActions() {
  const { t } = useTranslation();
  const signedIn = useIsSignedIn();
  const primary =
    'focus-ring group relative hidden h-9 items-center gap-1.5 overflow-hidden rounded-xl bg-accent px-4 text-sm font-semibold text-on-accent shadow-sm transition-all duration-200 hover:shadow-glow-accent active:scale-95 lg:flex';

  if (signedIn) {
    return (
      <Link to="/dashboard" className={primary}>
        <LayoutDashboard size={15} className="relative" aria-hidden="true" />
        <span className="relative">Dashboard</span>
      </Link>
    );
  }
  return (
    <>
      <Link
        to="/login"
        className="focus-ring hidden h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-text-secondary transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary xl:flex"
      >
        <LogIn size={15} aria-hidden="true" />
        {t('cta.login')}
      </Link>
      <Link to="/signup" className={primary}>
        <span className="relative">{t('cta.startFreeTrial')}</span>
        <ArrowRight size={15} className="relative transition-transform duration-200 group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" aria-hidden="true" />
        <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-500 group-hover:translate-x-full motion-reduce:hidden rtl:hidden" />
      </Link>
    </>
  );
}

function DrawerActions({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation();
  const signedIn = useIsSignedIn();
  const base =
    'focus-ring flex h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-all active:scale-[0.98]';
  return (
    <div className="space-y-3 border-t border-border px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5"
      {signedIn ? (
        <Link to="/dashboard" onClick={onNavigate} className={`${base} bg-accent text-on-accent shadow-sm hover:shadow-glow-accent`}>
          <LayoutDashboard size={16} aria-hidden="true" />
          Dashboard
        </Link>
      ) : (
        <>
          <Link to="/signup" onClick={onNavigate} className={`group ${base} bg-accent text-on-accent shadow-sm hover:shadow-glow-accent`}>
            {t('cta.startFreeTrial')}
            <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" aria-hidden="true" />
          </Link>
          <Link to="/login" onClick={onNavigate} className={`${base} border border-border bg-bg-tertiary text-text-primary`}>
            <LogIn size={16} aria-hidden="true" />
            {t('cta.login')}
          </Link>
        </>
      )}
      <a href={SARAH_PHONE} onClick={onNavigate} className={`${base} text-text-secondary hover:bg-bg-tertiary hover:text-text-primary`}>
        <Phone size={16} aria-hidden="true" />
        {t('cta.talkToSarah')}
      </a>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Hamburger                                                          */
/* ------------------------------------------------------------------ */

const HamburgerButton = forwardRef<HTMLButtonElement, { open: boolean; onClick: () => void }>(function HamburgerButton(
  { open, onClick },
  ref,
) {
  const { t } = useTranslation();
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={open ? t('menu.close') : t('menu.open')}
      aria-expanded={open}
      className="focus-ring relative flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary/80 text-text-primary transition-colors hover:bg-bg-tertiary lg:hidden"
    >
      <div className="relative flex h-4 w-5 flex-col justify-between">
        <motion.span
          animate={open ? { rotate: 45, y: 7 } : { rotate: 0, y: 0 }}
          transition={{ duration: 0.2, ease: EASE }}
          className="block h-0.5 w-5 rounded-full bg-current"
        />
        <motion.span
          animate={open ? { opacity: 0, scaleX: 0 } : { opacity: 1, scaleX: 1 }}
          transition={{ duration: 0.15 }}
          className="block h-0.5 w-5 rounded-full bg-current"
        />
        <motion.span
          animate={open ? { rotate: -45, y: -7 } : { rotate: 0, y: 0 }}
          transition={{ duration: 0.2, ease: EASE }}
          className="block h-0.5 w-5 rounded-full bg-current"
        />
      </div>
    </button>
  );
});

/* ------------------------------------------------------------------ */
/*  Header                                                             */
/* ------------------------------------------------------------------ */

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SiteHeader() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const reduce = useReducedMotion();
  const { isRtl } = useDirection();
  const [scrolled, setScrolled] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 280, damping: 40, mass: 0.3 });

  const closeDrawer = useCallback((restore = false) => {
    restoreFocus.current = restore;
    setDrawerOpen(false);
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Lock page scroll while the drawer is open. Compensates for a classic scrollbar
  // disappearing (no layout jump) and restores whatever inline styles were there before.
  useEffect(() => {
    if (!drawerOpen) return;
    const { body, documentElement } = document;
    const prevOverflow = body.style.overflow;
    const prevPaddingRight = body.style.paddingRight;
    const scrollbarGap = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbarGap > 0) body.style.paddingRight = `${scrollbarGap}px`;
    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPaddingRight;
    };
  }, [drawerOpen]);

  // Close on route change.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Close if the viewport grows into the desktop layout (the drawer is hidden there).
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setDrawerOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Escape closes; Tab is trapped inside the drawer (list re-read on every keypress,
  // because the accordion adds and removes links while it is open).
  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    drawer.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeDrawer(true);
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !drawer.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !drawer.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen, closeDrawer]);

  // After an explicit close (Escape / X), hand focus back to the hamburger.
  useEffect(() => {
    if (!drawerOpen && restoreFocus.current) {
      restoreFocus.current = false;
      hamburgerRef.current?.focus();
    }
  }, [drawerOpen]);

  return (
    <>
      <motion.header
        initial={reduce ? false : { y: -24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: EASE }}
        className="fixed inset-x-0 top-0 z-sticky"
      >
        {/* Scroll progress */}
        <motion.div
          aria-hidden="true"
          style={{ scaleX: progress }}
          className="scroll-progress pointer-events-none absolute inset-x-0 top-0 h-0.5 origin-left bg-accent"
        />

        <div className="mx-auto max-w-7xl px-4 pt-3 sm:px-6 sm:pt-4">
          <div
            className={`relative flex items-center justify-between gap-4 rounded-2xl px-4 py-2.5 transition-all duration-300 ease-out sm:px-5 sm:py-3 ${
              scrolled
                ? 'border border-border/70 bg-bg-secondary/80 shadow-lg shadow-text-secondary/5 backdrop-blur-xl'
                : 'border border-transparent bg-transparent'
            }`}
          >
            <Link
              to="/"
              className="focus-ring flex shrink-0 items-center gap-2.5 rounded-lg transition-opacity duration-200 hover:opacity-90"
              aria-label="Vireek home"
            >
              <Logo />
              <span className="text-base font-bold tracking-tight text-text-primary">Vireek</span>
            </Link>

            <DesktopMegaNav />

            <div className="flex items-center gap-2 sm:gap-3">
              <DesktopActions />
              <HamburgerButton ref={hamburgerRef} open={drawerOpen} onClick={() => setDrawerOpen((v) => !v)} />
            </div>
          </div>
        </div>
      </motion.header>

      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => closeDrawer()}
              aria-hidden="true"
              className="fixed inset-0 z-overlay bg-overlay/60 backdrop-blur-md lg:hidden"
            />
            <motion.aside
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Site menu"
              initial={{ x: isRtl ? '-100%' : '100%' }}
              animate={{ x: 0 }}
              exit={{ x: isRtl ? '-100%' : '100%' }}
              transition={{ duration: reduce ? 0 : 0.35, ease: EASE }}
              className="fixed inset-y-0 end-0 z-modal flex w-11/12 max-w-sm flex-col border-s border-border bg-bg-secondary shadow-elevation-4 lg:hidden"
            >
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <Link to="/" className="focus-ring flex items-center gap-2.5 rounded-lg" onClick={() => closeDrawer()} aria-label="Vireek home">
                  <Logo px={32} />
                  <span className="text-base font-bold tracking-tight text-text-primary">Vireek</span>
                </Link>
                <button
                  type="button"
                  onClick={() => closeDrawer(true)}
                  aria-label={t('menu.close')}
                  className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-tertiary text-text-secondary transition-colors hover:text-text-primary active:scale-95"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <MobileNav onNavigate={() => closeDrawer()} />
              <DrawerActions onNavigate={() => closeDrawer()} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
