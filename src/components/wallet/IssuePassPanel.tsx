/**
 * Issue a wallet pass: pick a record, then copy/scan the link or text it to the customer.
 * Issuing is idempotent — re-issuing returns the same pass (and link).
 */

import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Loader2, MessageSquare, Search } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { fetchWalletCandidates, issueWalletPass } from '@/lib/walletPassesApi';
import { WALLET_KIND_META, defaultTimezone, phoneLooksValid, type IssueResult, type WalletCandidate, type WalletKind } from '@/lib/walletPasses';

export function IssuePassPanel({ kind, onIssued }: { kind: WalletKind; onIssued: () => void }) {
  const { toast } = useToast();
  const meta = WALLET_KIND_META[kind];
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<WalletCandidate[] | null>(null);
  const [picked, setPicked] = useState<WalletCandidate | null>(null);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState<'link' | 'sms' | null>(null);
  const [result, setResult] = useState<IssueResult | null>(null);
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => { setPicked(null); setResult(null); setQuery(''); setPhone(''); }, [kind]);

  useEffect(() => {
    let live = true;
    setItems(null);
    const t = setTimeout(() => {
      fetchWalletCandidates(kind, query).then((r) => live && setItems(r)).catch(() => { if (live) { setItems([]); toast('Could not load records.', 'error'); } });
    }, query ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [kind, query, toast]);

  const choose = useCallback((c: WalletCandidate) => { setPicked(c); setResult(null); setPhone(c.phone ?? ''); }, []);

  const run = async (sms: boolean) => {
    if (!picked) return;
    if (sms && !phoneLooksValid(phone)) { toast('Enter a valid mobile number.', 'error'); return; }
    setBusy(sms ? 'sms' : 'link');
    try {
      const r = await issueWalletPass({ kind, subjectId: picked.id, timezone: defaultTimezone(), sendSms: sms, phone: sms ? phone : undefined });
      setResult(r);
      setQr(await QRCode.toDataURL(r.url, { width: 200, margin: 1 }).catch(() => ''));
      if (sms && r.sms) toast(r.sms.message, r.sms.ok ? 'success' : 'error');
      else toast('Pass link ready.', 'success');
      onIssued();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the pass.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!result) return;
    try { await navigator.clipboard.writeText(result.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { toast('Copy failed — select the link manually.', 'error'); }
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <h2 className="text-sm font-semibold text-text-primary">Issue a {meta.noun}</h2>
      <p className="mt-0.5 text-xs text-text-secondary">{meta.description}</p>

      <label className="relative mt-3 block">
        <span className="sr-only">{meta.searchHint}</span>
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-secondary" aria-hidden />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={meta.searchHint}
          className="focus-ring h-9 w-full rounded-lg border border-border bg-bg-primary pl-9 pr-3 text-sm text-text-primary placeholder:text-text-secondary" />
      </label>

      <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto" aria-busy={items === null}>
        {items === null && <li className="flex items-center gap-2 px-2 py-3 text-xs text-text-secondary"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading…</li>}
        {items?.length === 0 && <li className="px-2 py-3 text-xs text-text-secondary">Nothing to issue a pass for yet.</li>}
        {items?.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => choose(c)} aria-pressed={picked?.id === c.id}
              className={`focus-ring w-full rounded-lg border px-3 py-2 text-left transition-colors ${picked?.id === c.id ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-bg-tertiary'}`}>
              <p className="truncate text-sm font-medium text-text-primary">{c.label}</p>
              <p className="truncate text-xs text-text-secondary">{c.detail}</p>
            </button>
          </li>
        ))}
      </ul>

      {picked && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {kind !== 'gift_card' && kind !== 'tech_badge' && (
            <label className="block">
              <span className="text-xs font-medium text-text-secondary">Customer mobile (to text the link)</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" placeholder="(555) 123-4567"
                className="focus-ring mt-1 h-9 w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary" />
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void run(false)} disabled={busy !== null}>{busy === 'link' && <Loader2 className="h-4 w-4 animate-spin" />} Create link</Button>
            {kind !== 'gift_card' && kind !== 'tech_badge' && (
              <Button size="sm" variant="secondary" onClick={() => void run(true)} disabled={busy !== null}>
                {busy === 'sms' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />} Text link
              </Button>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-border bg-bg-primary p-3">
          {qr && <img src={qr} alt="QR code for the wallet link" width={96} height={96} className="rounded bg-white p-1" />}
          <div className="min-w-0 flex-1">
            <p className="break-all text-xs text-text-primary">{result.url}</p>
            <Button size="sm" variant="ghost" onClick={() => void copy()} className="mt-1">{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy link'}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
