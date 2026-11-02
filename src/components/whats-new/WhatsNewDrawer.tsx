import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Sparkles, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useWhatsNew } from '@/contexts/WhatsNewContext';
import { useProductTour } from '@/contexts/ProductTourContext';
import { useDialogA11y } from '@/components/feedback/useDialogA11y';
import { listYouAskedWeBuilt, type YouAsked } from '@/lib/feedback/api';
import { OPEN_WHATS_NEW_EVENT } from '@/lib/feedback/events';
import { isRelevantForRole, safeDeepLink } from '@/lib/whatsNewRelevance';

const READ_DELAY_MS = 3000;
const MAX_RELEASES = 4;

/** Release-notes drawer: latest releases filtered to what's relevant for the signed-in role, deep links, "You asked, we built". */
export function WhatsNewDrawer() {
  const { profile, teamMember } = useAuth();
  const { releases, unreadIds, markRead } = useWhatsNew();
  const { replayTour } = useProductTour();
  const role = teamMember?.role ?? profile?.role ?? null;
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState<YouAsked[]>([]);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());

  useDialogA11y(open, ref, () => setOpen(false));

  useEffect(() => {
    const on = () => { setFresh(new Set(unreadIds)); setOpen(true); void listYouAskedWeBuilt(3).then(setAsked).catch(() => setAsked([])); };
    window.addEventListener(OPEN_WHATS_NEW_EVENT, on);
    return () => window.removeEventListener(OPEN_WHATS_NEW_EVENT, on);
  }, [unreadIds]);

  useEffect(() => {
    if (!open || fresh.size === 0) return;
    const t = window.setTimeout(() => void markRead(Array.from(fresh)), READ_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [open, fresh, markRead]);

  const visible = useMemo(
    () => releases.slice(0, MAX_RELEASES).map((r) => ({ ...r, entries: r.entries.filter((e) => isRelevantForRole(e, role)) })).filter((r) => r.entries.length > 0),
    [releases, role],
  );

  if (!open) return null;
  const close = () => setOpen(false);

  return (
    <div className="fixed inset-0 z-[60] bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-border bg-bg-secondary shadow-card-hover">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 id={titleId} className="flex items-center gap-2 text-lg font-bold text-text-primary"><Sparkles className="h-5 w-5" aria-hidden="true" /> What’s new</h2>
          <button type="button" onClick={close} aria-label="Close what’s new" className="focus-ring rounded-lg p-1 text-text-secondary hover:bg-bg-tertiary"><X size={18} /></button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {asked.length > 0 && (
            <section aria-label="You asked, we built" className="rounded-xl border border-accent/30 bg-accent/5 p-3">
              <h3 className="text-sm font-bold text-text-primary">You asked, we built</h3>
              <ul className="mt-2 space-y-2">
                {asked.map((a) => {
                  const link = safeDeepLink(a.href ?? undefined);
                  return (
                    <li key={a.id} className="text-sm">
                      <p className="font-medium text-text-primary">{a.title}</p>
                      <p className="text-text-secondary">{a.body}</p>
                      {link && <Link to={link} onClick={close} className="focus-ring inline-flex items-center gap-1 rounded text-accent hover:underline">Try it <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {visible.length === 0 ? <p className="text-sm text-text-secondary">Nothing new for your role right now.</p> : visible.map((r) => (
            <section key={r.id} aria-label={r.date}>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                {r.date}{fresh.has(r.id) && <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-white">New</span>}
              </h3>
              <ul className="mt-2 space-y-3">
                {r.entries.map((e) => {
                  const link = safeDeepLink(e.href);
                  return (
                    <li key={e.title} className="text-sm">
                      <p className="font-medium text-text-primary">{e.title}</p>
                      <p className="text-text-secondary">{e.body}</p>
                      <div className="mt-1 flex flex-wrap gap-3">
                        {link && <Link to={link} onClick={close} className="focus-ring inline-flex items-center gap-1 rounded text-accent hover:underline">Open <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>}
                        {e.tour && <button type="button" onClick={() => { close(); replayTour(); }} className="focus-ring rounded text-accent hover:underline">Take the tour</button>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
        <div className="border-t border-border p-3 text-sm">
          <Link to="/dashboard/whats-new" onClick={close} className="focus-ring rounded font-medium text-accent hover:underline">See all updates</Link>
        </div>
      </div>
    </div>
  );
}
