import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LifeBuoy, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { pageLabel } from '@/lib/helpCenter';
import { createTicket } from '@/lib/supportTicketsApi';
import { BODY_MAX, validateTicketInput } from '@/lib/supportTickets';
import { buildDiagnostics, diagnosticsToText, installErrorCapture } from '@/lib/supportDiagnostics';

// Start capturing client errors as soon as the dashboard shell loads (idempotent).
installErrorCapture();

const RESERVED_FOR_DIAGNOSTICS = 1_600; // keeps body + diagnostics under BODY_MAX (5000)

/**
 * Contextual Help link + "Report a problem" on every dashboard page. The ticket carries the route,
 * the last client errors (scrubbed) and call/job ids read from the URL — nothing else.
 */
export function SupportDock() {
  const { pathname } = useLocation();
  const { user, profile, teamMember, isOwner } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const userId = user?.id;
  const label = pageLabel(pathname);

  useEffect(() => {
    if (!open) return;
    areaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy]);

  if (!ownerId || !userId) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const subject = `Problem on ${label ?? pathname}`.slice(0, 120);
    const found = validateTicketInput({ subject, body: text });
    if (found.body) { setError(found.body); return; }
    if (text.trim().length > BODY_MAX - RESERVED_FOR_DIAGNOSTICS) {
      setError(`Keep the message under ${(BODY_MAX - RESERVED_FOR_DIAGNOSTICS).toLocaleString('en-US')} characters.`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const diag = buildDiagnostics(pathname);
      await createTicket(
        { ownerId, userId, name: profile?.company_name || profile?.full_name || null, email: profile?.email ?? null },
        { subject, body: `${text.trim()}\n\n${diagnosticsToText(diag)}`, category: 'technical', priority: 'normal' },
        [],
        { diagnostics: diag, pagePath: diag.route },
      );
      toast('Thanks — your report was sent with the details we need.', 'success');
      setText('');
      setOpen(false);
    } catch {
      setError('We couldn’t send your report. Check your connection and try again — nothing was lost.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="no-print fixed bottom-4 left-4 z-30 flex items-center gap-1 rounded-full border border-border bg-bg-secondary px-1 py-1 text-xs shadow-sm lg:left-64">
        <Link to="/dashboard/help" className="focus-ring rounded-full px-3 py-1.5 text-text-secondary hover:text-text-primary">
          {label ? `Help: ${label}` : 'Help'}
        </Link>
        <button type="button" onClick={() => setOpen(true)} className="focus-ring inline-flex items-center gap-1 rounded-full px-3 py-1.5 font-medium text-text-primary hover:bg-bg-tertiary">
          <LifeBuoy className="h-3.5 w-3.5" aria-hidden="true" /> Report a problem
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setOpen(false); }}>
          <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="report-problem-title" className="w-full max-w-lg rounded-2xl border border-border bg-bg-primary p-5 shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-3">
              <h2 id="report-problem-title" className="text-lg font-semibold text-text-primary">Report a problem</h2>
              <button type="button" aria-label="Close" disabled={busy} onClick={() => setOpen(false)} className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary"><X className="h-5 w-5" /></button>
            </div>
            <label htmlFor="report-problem-text" className="mb-1.5 block text-sm font-medium text-text-primary">What went wrong?</label>
            <textarea id="report-problem-text" ref={areaRef} rows={5} value={text} disabled={busy} onChange={(e) => setText(e.target.value)}
              aria-invalid={error ? true : undefined} aria-describedby="report-problem-help"
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary focus-visible:border-accent" />
            {error && <p role="alert" className="mt-1.5 text-sm text-danger">{error}</p>}
            <p id="report-problem-help" className="mt-2 text-xs text-text-secondary">
              We attach the page you’re on, the last few error messages and any call or job ID in the address. Never passwords, card data or what you typed into forms.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send report'}</Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
