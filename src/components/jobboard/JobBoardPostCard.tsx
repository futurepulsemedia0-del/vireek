import { useState } from 'react';
import { ArrowRightLeft, Check, Clock, Copy, Loader2, Mail, MapPin, RotateCcw, ShieldAlert, Siren, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { TRADE_CATEGORY_LABELS, TRADE_CATEGORY_OPTIONS } from '@/lib/laborMarketplace';
import { jobBoardApi } from '@/lib/jobBoardApi';
import {
  AUDIENCE_LABELS,
  AWARDED_VIA_LABELS,
  CLAIM_MODE_LABELS,
  EVENT_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  buildVendorLink,
  describeJobBoardError,
  formatMoney,
  formatOpensIn,
  formatShiftWindow,
  formatTimeLeft,
  needsAttention,
  parseDollarsToCents,
  sortBids,
  suggestTrade,
  vendorMailto,
  type JobBoardBid,
  type JobBoardEvent,
  type JobBoardPost,
  type JobBoardRecipient,
  type JobBoardVendor,
} from '@/lib/jobBoard';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

interface Props {
  post: JobBoardPost;
  recipients: JobBoardRecipient[];
  bids: JobBoardBid[];
  technicians: Array<{ id: string; name: string }>;
  vendors: JobBoardVendor[];
  company: string;
  now: number;
  busy: boolean;
  /** Runs an action with the shared busy/toast/refresh handling. */
  run: (id: string, fn: () => Promise<unknown>, success: string) => Promise<boolean>;
  onCancel: () => void;
}

type Panel = 'none' | 'override' | 'escalate' | 'history';

export function JobBoardPostCard({ post, recipients, bids, technicians, vendors, company, now, busy, run, onCancel }: Props) {
  const { toast } = useToast();
  const [panel, setPanel] = useState<Panel>('none');
  const [events, setEvents] = useState<JobBoardEvent[] | null>(null);
  const [priceDraft, setPriceDraft] = useState<Record<string, string>>({});
  const [target, setTarget] = useState(''); // "t:<id>" | "v:<id>"
  const [reason, setReason] = useState('');
  const [overridePrice, setOverridePrice] = useState('');
  const [trade, setTrade] = useState(suggestTrade(post.skill));
  const [fee, setFee] = useState('10');
  const [notes, setNotes] = useState('');
  const [smart, setSmart] = useState(true);
  const [linkBusy, setLinkBusy] = useState<string | null>(null);

  const activeBids = sortBids(bids);
  const techRecipients = recipients.filter((r) => r.recipient_type === 'technician');
  const vendorRecipients = recipients.filter((r) => r.recipient_type === 'vendor');
  const live = post.status === 'open';
  const urgent = post.priority === 'urgent' && live;
  const attention = needsAttention(post, activeBids.length);
  const spinner = busy ? <Loader2 size={14} className="animate-spin" /> : null;
  const expired = post.status === 'expired' || (live && new Date(post.expires_at).getTime() <= now);

  const togglePanel = (p: Panel) => setPanel((cur) => (cur === p ? 'none' : p));

  const openHistory = async () => {
    if (panel === 'history') {
      setPanel('none');
      return;
    }
    setPanel('history');
    try {
      setEvents(await jobBoardApi.listEvents(post.id));
    } catch (e) {
      toast(describeJobBoardError(e), 'error');
    }
  };

  const award = (bid: JobBoardBid) => {
    const draft = priceDraft[bid.id];
    const cents = draft?.trim() ? parseDollarsToCents(draft) : null;
    if (draft?.trim() && cents === null) {
      toast('Enter a valid price, e.g. 750 or 750.00', 'error');
      return;
    }
    void run(post.id, () => jobBoardApi.awardBid(post.id, bid.id, cents), `Awarded to ${bid.label}`);
  };

  const submitOverride = () => {
    if (!target) {
      toast('Choose who gets the job.', 'error');
      return;
    }
    if (reason.trim().length < 3) {
      toast('Add a short reason for the audit trail.', 'error');
      return;
    }
    const cents = overridePrice.trim() ? parseDollarsToCents(overridePrice) : null;
    if (overridePrice.trim() && cents === null) {
      toast('Enter a valid price, e.g. 750 or 750.00', 'error');
      return;
    }
    const [kind, id] = [target.slice(0, 1), target.slice(2)];
    void run(
      post.id,
      () => jobBoardApi.override(post.id, kind === 't' ? { technicianId: id } : { vendorId: id }, reason.trim(), cents),
      'Assigned by dispatcher override',
    ).then((ok) => {
      if (ok) setPanel('none');
    });
  };

  const submitEscalate = () => {
    const pct = Number(fee);
    if (!Number.isFinite(pct) || pct < 0 || pct > 50) {
      toast('Enter a referral fee between 0 and 50%.', 'error');
      return;
    }
    void run(post.id, () => jobBoardApi.escalate(post.id, trade, pct, notes.trim(), smart), 'Sent to the Contractor Network').then((ok) => {
      if (ok) setPanel('none');
    });
  };

  const copyLink = async (vendor: JobBoardRecipient, mail: boolean) => {
    if (!vendor.vendor_id) return;
    setLinkBusy(vendor.vendor_id);
    try {
      const token = await jobBoardApi.issueVendorLink(post.id, vendor.vendor_id);
      const link = buildVendorLink(window.location.origin, token);
      if (mail) {
        const email = vendors.find((v) => v.id === vendor.vendor_id)?.email ?? null;
        const href = vendorMailto({ email, company, title: post.title, link });
        if (href) window.location.href = href;
        else toast('This subcontractor has no e-mail on file — link copied instead.', 'info');
        if (!href) await navigator.clipboard.writeText(link);
      } else {
        await navigator.clipboard.writeText(link);
        toast('Private link copied — it replaces any earlier link for this subcontractor.', 'success');
      }
    } catch (e) {
      toast(describeJobBoardError(e), 'error');
    } finally {
      setLinkBusy(null);
    }
  };

  const reopenLabel = post.status === 'open' ? 'Extend 1 hour' : post.status === 'awarded' ? 'Release & re-open' : 'Re-open';

  return (
    <article className={`rounded-xl border bg-bg-secondary p-4 ${urgent ? 'border-cta/60' : attention ? 'border-warning-500/60' : 'border-border'}`}>
      <div className="flex flex-wrap items-center gap-2">
        {post.priority === 'urgent' && (
          <span className="inline-flex items-center gap-1 rounded-full bg-cta/10 px-2 py-0.5 text-xs font-semibold text-cta">
            <Siren size={12} /> Urgent
          </span>
        )}
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[post.status]}`}>{STATUS_LABELS[post.status]}</span>
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">{CLAIM_MODE_LABELS[post.claim_mode]}</span>
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">{AUDIENCE_LABELS[post.audience]}</span>
        {live && (
          <span className={`ml-auto inline-flex items-center gap-1 text-xs ${urgent ? 'font-semibold text-cta' : 'text-text-secondary'}`}>
            <Clock size={12} /> {formatTimeLeft(post.expires_at, now)}
          </span>
        )}
      </div>

      <h3 className="mt-2 text-sm font-semibold text-text-primary">{post.title}</h3>
      {post.summary && <p className="mt-1 whitespace-pre-line text-sm text-text-secondary">{post.summary}</p>}

      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-secondary">
        <div>{formatShiftWindow(post.starts_at, post.duration_minutes)}</div>
        {post.location_label && (
          <div className="flex items-center gap-1">
            <MapPin size={12} />
            {post.location_label}
          </div>
        )}
        {post.skill && <div className="capitalize">Skill: {post.skill}</div>}
        {post.offer_cents !== null && <div>Offer {formatMoney(post.offer_cents)}</div>}
        {post.max_bid_cents !== null && <div>Max bid {formatMoney(post.max_bid_cents)}</div>}
        {post.auto_award && <div>Auto-awards at expiry</div>}
      </dl>

      {post.status === 'awarded' && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-text-primary">
          <Check size={14} className="text-success-500" />
          <span>
            <span className="font-medium">{post.awarded_label ?? 'Awarded'}</span>
            {post.awarded_via && <span className="text-text-secondary"> · {AWARDED_VIA_LABELS[post.awarded_via]}</span>}
            {post.awarded_price_cents !== null && <span className="text-text-secondary"> · {formatMoney(post.awarded_price_cents)}</span>}
            {post.override_reason && <span className="block text-xs text-text-secondary">Reason: {post.override_reason}</span>}
          </span>
        </p>
      )}
      {post.status === 'escalated' && (
        <p className="mt-3 text-sm text-text-secondary">
          Waiting for a Contractor Network member to accept.{' '}
          <a href="/dashboard/network/handoffs?tab=posted" className="focus-ring text-accent underline">
            View handoff
          </a>
        </p>
      )}
      {expired && post.status === 'expired' && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-warning-500">
          <ShieldAlert size={14} /> Expired unclaimed — re-open it, assign it directly or send it to the network.
        </p>
      )}

      {/* Broadcast list */}
      {recipients.length > 0 && (
        <div className="mt-3 rounded-lg bg-bg-primary p-3 text-xs text-text-secondary">
          <p className="font-medium text-text-primary">
            Offered to {techRecipients.length} technician{techRecipients.length === 1 ? '' : 's'}
            {vendorRecipients.length > 0 && ` and ${vendorRecipients.length} subcontractor${vendorRecipients.length === 1 ? '' : 's'}`}
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {recipients
              .slice()
              .sort((a, b) => a.opens_at.localeCompare(b.opens_at) || a.rank - b.rank)
              .map((r) => {
                const waiting = live && !r.declined_at && new Date(r.opens_at).getTime() > now;
                return (
                  <li
                    key={r.id}
                    className={`rounded-full border px-2 py-0.5 ${r.declined_at ? 'border-border line-through opacity-60' : r.wave === 1 && r.recipient_type === 'technician' ? 'border-accent/50 text-text-primary' : 'border-border'}`}
                    title={r.declined_at ? `Declined${r.decline_reason ? `: ${r.decline_reason}` : ''}` : `Awards in window: ${r.fairness_awards}`}
                  >
                    {r.label}
                    {r.recipient_type === 'vendor' && ' (sub)'}
                    {waiting && <span className="ml-1 text-text-secondary">· {formatOpensIn(r.opens_at, now)}</span>}
                  </li>
                );
              })}
          </ul>
        </div>
      )}

      {/* Bids */}
      {live && activeBids.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Requests & bids</p>
          {activeBids.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text-primary">
                  {b.label} <span className="text-xs font-normal text-text-secondary">{b.bidder_type === 'vendor' ? 'subcontractor' : 'technician'}</span>
                </p>
                <p className="text-xs text-text-secondary">
                  {b.price_cents !== null ? formatMoney(b.price_cents) : 'No price'}
                  {b.note ? ` · ${b.note}` : ''}
                </p>
              </div>
              <div className="w-28">
                <Input
                  aria-label={`Final price for ${b.label}`}
                  placeholder={b.price_cents !== null ? (b.price_cents / 100).toFixed(2) : 'Price $'}
                  value={priceDraft[b.id] ?? ''}
                  onChange={(e) => setPriceDraft((d) => ({ ...d, [b.id]: e.target.value }))}
                  inputMode="decimal"
                />
              </div>
              <Button size="sm" disabled={busy} onClick={() => award(b)}>
                {spinner}Award
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Subcontractor private links */}
      {live && vendorRecipients.filter((v) => !v.declined_at).length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Subcontractor links</p>
          {vendorRecipients
            .filter((v) => !v.declined_at)
            .map((v) => (
              <div key={v.id} className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                <span className="min-w-0 flex-1 font-medium text-text-primary">{v.label}</span>
                <span>{formatOpensIn(v.opens_at, now)}</span>
                <Button variant="secondary" size="sm" disabled={linkBusy === v.vendor_id} onClick={() => void copyLink(v, false)}>
                  {linkBusy === v.vendor_id ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
                  Copy link
                </Button>
                <Button variant="ghost" size="sm" disabled={linkBusy === v.vendor_id} onClick={() => void copyLink(v, true)}>
                  <Mail size={14} />
                  E-mail
                </Button>
              </div>
            ))}
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 flex flex-wrap gap-2">
        {(live || post.status === 'expired') && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => togglePanel('override')}>
            Assign directly
          </Button>
        )}
        {(live || post.status === 'expired') && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => togglePanel('escalate')}>
            <ArrowRightLeft size={14} />
            Send to network
          </Button>
        )}
        {(post.status === 'open' || post.status === 'expired' || post.status === 'awarded' || post.status === 'escalated') && !(post.status === 'awarded' && post.awarded_to_type === 'network') && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void run(post.id, () => jobBoardApi.reopen(post.id, post.status === 'open' ? 60 : null), post.status === 'open' ? 'Extended by an hour' : 'Re-opened')}
          >
            <RotateCcw size={14} />
            {reopenLabel}
          </Button>
        )}
        {(post.status === 'open' || post.status === 'expired' || post.status === 'escalated') && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            <X size={14} />
            Cancel post
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => void openHistory()}>
          History
        </Button>
      </div>

      {panel === 'override' && (
        <div className="mt-3 space-y-3 rounded-lg border border-border p-3">
          <p className="text-xs text-text-secondary">
            A dispatcher override skips skill, zone, availability and fairness checks. It is recorded in the audit trail with your reason.
          </p>
          <div>
            <label htmlFor={`ov-${post.id}`} className="mb-1.5 block text-sm font-medium text-text-primary">
              Assign to
            </label>
            <select id={`ov-${post.id}`} value={target} onChange={(e) => setTarget(e.target.value)} className={selectClass}>
              <option value="">Choose…</option>
              <optgroup label="Technicians">
                {technicians.map((t) => (
                  <option key={t.id} value={`t:${t.id}`}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Subcontractors">
                {vendors
                  .filter((v) => v.enabled)
                  .map((v) => (
                    <option key={v.id} value={`v:${v.id}`}>
                      {v.name}
                    </option>
                  ))}
              </optgroup>
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Customer asked for Ted" />
            <Input label="Price ($, optional)" value={overridePrice} onChange={(e) => setOverridePrice(e.target.value)} inputMode="decimal" />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPanel('none')}>
              Close
            </Button>
            <Button size="sm" disabled={busy} onClick={submitOverride}>
              {spinner}Assign
            </Button>
          </div>
        </div>
      )}

      {panel === 'escalate' && (
        <div className="mt-3 space-y-3 rounded-lg border border-border p-3">
          <p className="text-xs text-text-secondary">
            Hands the job to the Contractor Network. The customer’s details travel only in the handoff’s private contact block, and this post follows the handoff automatically.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`tr-${post.id}`} className="mb-1.5 block text-sm font-medium text-text-primary">
                Trade
              </label>
              <select id={`tr-${post.id}`} value={trade} onChange={(e) => setTrade(e.target.value)} className={selectClass}>
                {TRADE_CATEGORY_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {TRADE_CATEGORY_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <Input label="Referral fee (%)" value={fee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" />
          </div>
          <Input label="Private notes for the contractor" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Gate code, parking, equipment…" />
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={smart} onChange={(e) => setSmart(e.target.checked)} />
            Smart-match: offer to the best qualified member first
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPanel('none')}>
              Close
            </Button>
            <Button size="sm" disabled={busy} onClick={submitEscalate}>
              {spinner}Send to network
            </Button>
          </div>
        </div>
      )}

      {panel === 'history' && (
        <ol className="mt-3 space-y-1.5 border-l border-border pl-3 text-xs text-text-secondary">
          {events === null ? (
            <li>Loading…</li>
          ) : events.length === 0 ? (
            <li>No activity recorded.</li>
          ) : (
            events.map((e) => (
              <li key={e.id}>
                <span className="font-medium text-text-primary">{EVENT_LABELS[e.event] ?? e.event}</span>
                {e.actor_label ? ` · ${e.actor_label}` : ''} · {new Date(e.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                {typeof e.detail?.reason === 'string' && e.detail.reason ? ` — ${e.detail.reason}` : ''}
              </li>
            ))
          )}
        </ol>
      )}
    </article>
  );
}
