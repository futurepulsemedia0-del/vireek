// Recreated: verify against original intent
// /dashboard/review-shield  (default export: App.tsx lazy-loads it without a named export)
//
// Review Shield, the part that can honestly run today: checks on text YOU paste, using the repository's pure engine
// (supabase/functions/_shared/review-shield). Nothing you paste is stored or sent anywhere.
//   1. Extortion check: does a review or message demand payment or threaten more reviews?
//   2. Reply check: is a draft public reply safe to post (no threats, accusations, pressure or customer data)?
//   3. Redaction: strip contact details and known customer values before sharing text.
// TODO(vireek): the monitoring side (review feed, burst detection over your history, evidence packs, appeals) needs
// a review-shield edge function and tables that do not exist in this repository (attack.ts / pack.ts are missing
// from the shared engine too). It is deliberately not faked here.

import { useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { scanForExtortionPatterns, type Channel, type ExtortionCode } from '../../supabase/functions/_shared/review-shield/patterns.ts';
import { lintReply, REPLY_MAX_CHARS, type ReplyIssue } from '../../supabase/functions/_shared/review-shield/reply.ts';
import { redactText, totalRedactions } from '../../supabase/functions/_shared/review-shield/redact.ts';

const MAX_TEXT = 5000;
const card = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const area = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
const lab = 'mb-1 block text-xs font-semibold text-text-secondary';

const CHANNELS: { value: Channel; label: string }[] = [
  { value: 'review', label: 'Public review' },
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'Text message' },
  { value: 'dm', label: 'Direct message' },
  { value: 'voicemail', label: 'Voicemail transcript' },
];
const EXTORTION: Record<ExtortionCode, string> = {
  payment_for_removal: 'Asks for money in exchange for removing or changing a review.',
  threat_more_reviews: 'Threatens to post more or fake reviews.',
  conditional_threat: 'Makes a demand conditional on a payment, refund or gift.',
  reputation_threat: 'Threatens to ruin your business or reputation.',
};
const REPLY_ISSUE: Record<ReplyIssue, string> = {
  legal_threat: 'Mentions legal action. Keep public replies free of legal threats; talk to a lawyer privately.',
  accusation: 'Accuses the reviewer (for example of lying or fraud). Stay factual and polite.',
  pressure: 'Asks the reviewer to change or remove the review, or offers something in exchange.',
  customer_data: 'Contains contact details or customer information that should not be public.',
  too_long: `Longer than ${REPLY_MAX_CHARS} characters. Short replies read better.`,
  empty: 'The reply is empty.',
};

function splitKnown(raw: string): string[] {
  return raw.split(/[\n,;]+/).map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 20);
}

function ReviewShieldPage() {
  const [text, setText] = useState('');
  const [channel, setChannel] = useState<Channel>('review');
  const [draft, setDraft] = useState('');
  const [known, setKnown] = useState('');
  const [source, setSource] = useState('');

  const hits = useMemo(() => (text.trim() ? scanForExtortionPatterns(text, channel) : null), [text, channel]);
  const codes = useMemo(() => (hits ? [...new Set(hits.map((h) => h.code))] : []), [hits]);
  const knownValues = useMemo(() => splitKnown(known), [known]);
  const lint = useMemo(() => (draft.trim() ? lintReply(draft, knownValues) : null), [draft, knownValues]);
  const redacted = useMemo(() => (source.trim() ? redactText(source, { knownValues }) : null), [source, knownValues]);

  return (
    <DashboardLayout activeLabel="Review Shield">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><ShieldCheck size={22} aria-hidden="true" /> Review Shield</h1>
        <p className="mt-1 text-sm text-text-secondary">Check a review, a reply or a message before you act on it. Everything runs in your browser; nothing you paste is saved or sent. These checks are a safety net, not legal advice.</p>
      </div>

      <section className={card} aria-labelledby="rs-extort">
        <h2 id="rs-extort" className="text-base font-semibold text-text-primary">Is this extortion?</h2>
        <p className="mt-0.5 text-xs text-text-secondary">Paste a review or message. An ordinary complaint, even a demand for a refund on its own, is not flagged.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_200px]">
          <div>
            <label htmlFor="rs-text" className={lab}>Text to check</label>
            <textarea id="rs-text" rows={5} maxLength={MAX_TEXT} value={text} onChange={(e) => setText(e.target.value)} className={area} />
          </div>
          <div>
            <label htmlFor="rs-channel" className={lab}>Where it came from</label>
            <select id="rs-channel" value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className="focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary">
              {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
        </div>
        <div role="status" aria-live="polite" className="mt-3 text-sm">
          {hits === null ? null : codes.length === 0 ? (
            <p className="text-text-secondary">No extortion wording found. That does not prove the review is genuine or fair.</p>
          ) : (
            <div className="rounded-xl border border-danger/30 bg-danger/5 p-3">
              <p className="font-semibold text-danger">Possible extortion wording</p>
              <ul className="mt-1 list-disc ps-5 text-text-primary">{codes.map((c) => <li key={c}>{EXTORTION[c]}</li>)}</ul>
              <p className="mt-2 text-xs text-text-secondary">Do not pay or negotiate. Keep a copy, do not reply in anger, and report it to the platform. If you feel threatened, contact the police.</p>
            </div>
          )}
        </div>
      </section>

      <section className={`${card} mt-4`} aria-labelledby="rs-known">
        <h2 id="rs-known" className="text-base font-semibold text-text-primary">Customer details to protect</h2>
        <p className="mt-0.5 text-xs text-text-secondary">Optional. One per line (names, phone numbers, emails, addresses). Used by the reply check and the redaction below.</p>
        <label htmlFor="rs-known-in" className="sr-only">Customer details to protect</label>
        <textarea id="rs-known-in" rows={3} maxLength={1000} value={known} onChange={(e) => setKnown(e.target.value)} className={`${area} mt-2`} />
      </section>

      <section className={`${card} mt-4`} aria-labelledby="rs-reply">
        <h2 id="rs-reply" className="text-base font-semibold text-text-primary">Is my reply safe to post?</h2>
        <label htmlFor="rs-draft" className={`${lab} mt-3`}>Draft public reply</label>
        <textarea id="rs-draft" rows={5} maxLength={MAX_TEXT} value={draft} onChange={(e) => setDraft(e.target.value)} className={area} />
        <p className="mt-1 text-[11px] text-text-secondary">{draft.length} / {REPLY_MAX_CHARS} characters recommended</p>
        <div role="status" aria-live="polite" className="mt-2 text-sm">
          {lint === null ? null : lint.ok ? (
            <p className="font-semibold text-success-500">Nothing blocks this reply. Read it once more as the reviewer would.</p>
          ) : (
            <div className="rounded-xl border border-warning-500/40 bg-warning-500/10 p-3">
              <p className="font-semibold text-warning-500">Fix before posting</p>
              <ul className="mt-1 list-disc ps-5 text-text-primary">{lint.issues.map((i) => <li key={i}>{REPLY_ISSUE[i]}</li>)}</ul>
            </div>
          )}
        </div>
      </section>

      <section className={`${card} mt-4`} aria-labelledby="rs-redact">
        <h2 id="rs-redact" className="text-base font-semibold text-text-primary">Remove personal details</h2>
        <p className="mt-0.5 text-xs text-text-secondary">Strips emails, phone numbers, street addresses, links, long numbers and the details you listed above. It errs on the side of removing too much; always read the result.</p>
        <label htmlFor="rs-src" className={`${lab} mt-3`}>Text to redact</label>
        <textarea id="rs-src" rows={5} maxLength={MAX_TEXT} value={source} onChange={(e) => setSource(e.target.value)} className={area} />
        {redacted && (
          <div className="mt-3" role="status" aria-live="polite">
            <p className="text-xs text-text-secondary">{totalRedactions(redacted.counts)} item{totalRedactions(redacted.counts) === 1 ? '' : 's'} removed.</p>
            <label htmlFor="rs-out" className={`${lab} mt-1`}>Redacted text</label>
            <textarea id="rs-out" readOnly rows={5} value={redacted.text} className={area} onFocus={(e) => e.currentTarget.select()} />
          </div>
        )}
      </section>
    </DashboardLayout>
  );
}

export default ReviewShieldPage;
export { ReviewShieldPage };
