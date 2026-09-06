import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Search,
  LayoutDashboard,
  PhoneCall,
  Users,
  Wrench,
  TrendingUp,
  Lightbulb,
  Settings,
  CreditCard,
  Plug,
  ShieldCheck,
  Bell,
  CornerDownLeft,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';

interface StaticPage {
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
  keywords?: string;
}

const PAGES: StaticPage[] = [
  { label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Call History', href: '/dashboard/calls', icon: PhoneCall },
  { label: 'Leads', href: '/dashboard/leads', icon: Users },
  { label: 'My Jobs', href: '/dashboard/jobs', icon: Wrench },
  { label: 'Analytics', href: '/dashboard/analytics', icon: TrendingUp },
  { label: 'Insights', href: '/dashboard/insights', icon: Lightbulb },
  { label: 'Notifications', href: '/dashboard/notifications', icon: Bell },
  { label: 'Business Profile', href: '/dashboard/business-profile', icon: Settings, keywords: 'settings' },
  { label: 'Team', href: '/dashboard/team', icon: ShieldCheck },
  { label: 'Billing', href: '/dashboard/billing', icon: CreditCard },
  { label: 'Integrations', href: '/dashboard/integrations', icon: Plug },
  { label: 'Security settings', href: '/dashboard/settings/security', icon: ShieldCheck, keywords: '2fa mfa audit' },
];

interface SearchResult {
  label: string;
  sublabel: string;
  href: string;
  icon: typeof PhoneCall;
}

/**
 * Global Cmd+K / Ctrl+K quick-navigation + search — step 16. Deliberately
 * NOT bound to "/" since several dashboard pages (Calls) already use "/" to
 * focus their own in-page search input; Cmd+K is the unambiguous, Linear-
 * style convention and doesn't collide with anything already shipped.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
    else {
      setQuery('');
      setResults([]);
    }
  }, [open]);

  const filteredPages = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PAGES;
    return PAGES.filter((p) => p.label.toLowerCase().includes(q) || p.keywords?.includes(q));
  }, [query]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timeout = setTimeout(async () => {
      const [callsRes, leadsRes, jobsRes] = await Promise.all([
        supabase.from('calls').select('id, caller_name, caller_phone').ilike('caller_name', `%${q}%`).limit(4),
        supabase.from('leads').select('id, name, phone').ilike('name', `%${q}%`).limit(4),
        supabase.from('jobs').select('id, customer_name, service_type').ilike('customer_name', `%${q}%`).limit(4),
      ]);
      if (cancelled) return;
      const found: SearchResult[] = [
        ...(callsRes.data ?? []).map((c) => ({
          label: c.caller_name ?? 'Unknown caller',
          sublabel: c.caller_phone ?? 'Call',
          href: '/dashboard/calls',
          icon: PhoneCall,
        })),
        ...(leadsRes.data ?? []).map((l) => ({
          label: l.name,
          sublabel: l.phone ?? 'Lead',
          href: '/dashboard/leads',
          icon: Users,
        })),
        ...(jobsRes.data ?? []).map((j) => ({
          label: j.customer_name,
          sublabel: j.service_type ?? 'Job',
          href: '/dashboard/jobs',
          icon: Wrench,
        })),
      ];
      setResults(found);
      setSearching(false);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [query]);

  const go = (href: string) => {
    setOpen(false);
    navigate(href);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[130] bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="fixed left-1/2 top-[14vh] z-[140] w-[92vw] max-w-lg -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
          >
            <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
              <Search size={17} className="text-text-secondary" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Jump to a page, or search calls, leads, jobs…"
                className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary/60"
              />
              <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                Esc
              </kbd>
            </div>

            <div className="max-h-[50vh] overflow-y-auto py-2">
              {results.length > 0 && (
                <>
                  <p className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/60">
                    Search results
                  </p>
                  {results.map((r, i) => (
                    <button
                      key={`${r.href}-${i}`}
                      type="button"
                      onClick={() => go(r.href)}
                      className="focus-ring flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-bg-tertiary"
                    >
                      <r.icon size={16} className="text-text-secondary" />
                      <span className="flex-1 truncate text-sm text-text-primary">{r.label}</span>
                      <span className="truncate text-xs text-text-secondary">{r.sublabel}</span>
                    </button>
                  ))}
                </>
              )}
              {searching && <p className="px-4 py-2 text-xs text-text-secondary">Searching…</p>}

              <p className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/60">
                Pages
              </p>
              {filteredPages.map((p) => (
                <button
                  key={p.href}
                  type="button"
                  onClick={() => go(p.href)}
                  className="focus-ring flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-bg-tertiary"
                >
                  <p.icon size={16} className="text-text-secondary" />
                  <span className="flex-1 truncate text-sm text-text-primary">{p.label}</span>
                  <CornerDownLeft size={13} className="text-text-secondary/40" />
                </button>
              ))}
              {filteredPages.length === 0 && results.length === 0 && !searching && (
                <p className="px-4 py-6 text-center text-sm text-text-secondary">No matches.</p>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
