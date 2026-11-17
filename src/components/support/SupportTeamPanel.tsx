// src/components/support/SupportTeamPanel.tsx
// Team tab: honest team status (with the real next opening time), every contact channel,
// self-service links and the copyable incident ID / diagnostic report.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, BookOpen, Check, Copy, Mail, MessageCircle, Ticket } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { OnlineDot } from '@/components/chat/ChatVisuals';
import { getNextSupportOpening, SUPPORT_HOURS_LABEL } from '@/lib/supportHours';

interface Props {
  online: boolean;
  signedIn: boolean;
  mailto: string;
  incidentId: string;
  hasReport: boolean;
  reportCopied: boolean;
  onTalkToTeam: () => void;
  onOpenTicket: () => void;
  onCopyReport: () => void;
  /** Called when a link inside the panel is followed, so the panel can close. */
  onNavigate: () => void;
}

const LINK_CLASS =
  'focus-ring inline-flex min-h-touch flex-1 items-center justify-center gap-2 rounded-control border border-border bg-bg-primary px-3 text-sm font-semibold text-text-primary hover:border-accent/40';

export function SupportTeamPanel({
  online, signedIn, mailto, incidentId, hasReport, reportCopied, onTalkToTeam, onOpenTicket, onCopyReport, onNavigate,
}: Props) {
  const [idCopied, setIdCopied] = useState(false);
  const next = online ? null : getNextSupportOpening();

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(incidentId);
      setIdCopied(true);
      setTimeout(() => setIdCopied(false), 2000);
    } catch { /* clipboard blocked: the ID stays visible on screen */ }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-surface border border-border bg-bg-tertiary p-3.5">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
          <OnlineDot online={online} /> {online ? 'Our team is online now' : 'Our team is offline'}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-text-secondary">
          {online
            ? `Team hours: ${SUPPORT_HOURS_LABEL}.`
            : `${next ? `Back ${next}. ` : ''}Leave a message and we reply by email. The Ask tab answers 24/7.`}
        </p>
      </div>

      <Button fullWidth size="sm" variant="primary" onClick={onTalkToTeam}>
        <MessageCircle size={16} aria-hidden="true" /> {online ? 'Chat with our team' : 'Leave a message'}
      </Button>
      {signedIn && (
        <Button fullWidth size="sm" variant="secondary" onClick={onOpenTicket}>
          <Ticket size={16} aria-hidden="true" /> Open a support ticket
        </Button>
      )}
      <a href={mailto} className={`${LINK_CLASS} w-full`}>
        <Mail size={16} aria-hidden="true" /> Email support
      </a>

      <div className="flex gap-2">
        <Link to="/help" onClick={onNavigate} className={LINK_CLASS}>
          <BookOpen size={16} aria-hidden="true" /> Help Center
        </Link>
        <Link to="/status" onClick={onNavigate} className={LINK_CLASS}>
          <Activity size={16} aria-hidden="true" /> System status
        </Link>
      </div>

      <div className="space-y-2 border-t border-border/70 pt-3">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
          Incident ID: <span className="font-mono text-text-primary">{incidentId}</span>
          <button
            type="button"
            onClick={() => void copyId()}
            aria-label={idCopied ? 'Incident ID copied' : 'Copy incident ID'}
            className="focus-ring inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-semibold text-accent hover:underline"
          >
            {idCopied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
            {idCopied ? 'Copied' : 'Copy'}
          </button>
        </p>
        <Button fullWidth size="sm" variant="secondary" disabled={!hasReport} disabledReason="Run the quick check on the Fix tab first" onClick={onCopyReport}>
          <Copy size={16} aria-hidden="true" /> {reportCopied ? 'Copied' : 'Copy diagnostic report'}
        </Button>
        <p className="text-xs text-text-secondary">The report has no email, password or token.</p>
      </div>
    </div>
  );
}
