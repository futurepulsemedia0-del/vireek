/** Owner-side Win Cards: review suggestions, choose exactly what is public, preview, approve, share, revoke. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Download, Loader2, Share2, Trophy } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import {
  DEFAULT_SELECTION, approveWinCard, dismissWinCard, extendWinCard, listWinCards, previewWinCard, recordWinCardShare, revokeWinCard,
  scanWinCards, updateWinCardSettings, winCardChatTargets, postWinCardToChat, type ChatTarget, type Selection, type Theme, type WinCard, type WinCardSettings,
} from '@/lib/winCardsApi';
import { INSTAGRAM_HINT, buildShareTargets, slackMessage, winCardImageUrl, winCardUrl } from '@/lib/winCardsShare';

const dataUri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const LABEL: Record<string, string> = {
  after_hours_booking: 'After-hours booking', emergency_handled: 'Emergency handled', recovered_large_job: 'Missed call recovered',
  milestone_calls: 'Call milestone', speed_to_lead_record: 'Response-time record', five_star_ai_job: '5-star review',
};

export function WinCardsPanel() {
  const { toast } = useToast();
  const [cards, setCards] = useState<WinCard[]>([]);
  const [settings, setSettings] = useState<WinCardSettings | null>(null);
  const [origin, setOrigin] = useState(window.location.origin);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [editing, setEditing] = useState<WinCard | null>(null);
  const [revoking, setRevoking] = useState<WinCard | null>(null);

  const reload = useCallback(async () => {
    const r = await listWinCards();
    if (!r.ok) { toast(r.error, 'error'); setLoading(false); return; }
    setCards(r.data.cards); setSettings(r.data.settings); setOrigin(r.data.siteUrl || window.location.origin); setLoading(false);
  }, [toast]);
  useEffect(() => { void reload(); }, [reload]);

  const scan = async () => {
    setScanning(true);
    const r = await scanWinCards();
    setScanning(false);
    if (!r.ok) return void toast(r.error, 'error');
    toast(r.data.inserted ? `${r.data.inserted} new win${r.data.inserted === 1 ? '' : 's'} found` : 'No new wins right now', 'success');
    await reload();
  };
  const patchSettings = async (p: Partial<WinCardSettings>) => {
    const r = await updateWinCardSettings(p);
    if (!r.ok) return void toast(r.error, 'error');
    setSettings(r.data.settings);
    toast('Settings saved', 'success');
  };

  const suggested = cards.filter((c) => c.status === 'suggested');
  const live = cards.filter((c) => c.status === 'approved' || c.status === 'suspended');

  if (loading) return <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" aria-busy="true" aria-label="Loading" />;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Win Cards</h1>
          <p className="text-sm text-text-secondary">Real outcomes, shared on your terms. Nothing is public until you approve it, and names, phone numbers, addresses and exact times are never shown.</p>
        </div>
        <button type="button" onClick={scan} disabled={scanning || !settings?.enabled || settings?.staff_locked} className="focus-ring inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
          {scanning ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Trophy size={16} aria-hidden="true" />} Find new wins
        </button>
      </div>

      {settings && (settings.staff_locked || !settings.enabled) && (
        <p role="status" className="rounded-xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary">
          {settings.staff_locked ? 'Win Cards are locked for this account. Contact support to change this.' : 'Win Cards are off. Existing links no longer work.'}
        </p>
      )}

      <section aria-labelledby="wc-suggested">
        <h2 id="wc-suggested" className="mb-3 text-lg font-semibold text-text-primary">Ready for your review</h2>
        {suggested.length === 0 ? (
          <EmptyState icon={Trophy} title="No wins to review" description="When a real event happens, such as an after-hours booking or a milestone, it shows up here for you to approve." />
        ) : (
          <ul className="space-y-3">
            {suggested.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
                <div>
                  <p className="font-medium text-text-primary">{LABEL[c.trigger_type]}</p>
                  <p className="text-xs text-text-secondary">Detected {new Date(c.created_at).toLocaleDateString()}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setEditing(c)} className="focus-ring rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white">Review card</button>
                  <button type="button" onClick={async () => { const r = await dismissWinCard(c.id); if (!r.ok) toast(r.error, 'error'); await reload(); }} className="focus-ring rounded-xl border border-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary">Dismiss</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="wc-live">
        <h2 id="wc-live" className="mb-3 text-lg font-semibold text-text-primary">Approved cards</h2>
        {live.length === 0 ? <p className="text-sm text-text-secondary">Approved cards and their share links appear here.</p> : (
          <ul className="space-y-4">{live.map((c) => <LiveCard key={c.id} card={c} origin={origin} onRevoke={() => setRevoking(c)} onChanged={reload} />)}</ul>
        )}
      </section>

      {settings && (
        <section aria-labelledby="wc-settings" className="rounded-2xl border border-border bg-bg-secondary p-5">
          <h2 id="wc-settings" className="text-lg font-semibold text-text-primary">Settings</h2>
          <div className="mt-3 space-y-3 text-sm text-text-secondary">
            <label className="flex items-center gap-2"><input type="checkbox" checked={settings.enabled} disabled={settings.staff_locked} onChange={(e) => patchSettings({ enabled: e.target.checked })} /> Allow Win Cards for this account (turning this off disables every existing link immediately)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={settings.white_label} onChange={(e) => patchSettings({ white_label: e.target.checked })} /> White-label cards (your brand name instead of Vireek, no link back to Vireek)</label>
            <label className="flex items-center gap-2">Link lifetime
              <select value={settings.default_expiry_days} onChange={(e) => patchSettings({ default_expiry_days: Number(e.target.value) })} className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1">
                {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2">Default look
              <select value={settings.theme} onChange={(e) => patchSettings({ theme: e.target.value as Theme })} className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1"><option value="light">Light</option><option value="dark">Dark</option></select>
            </label>
          </div>
        </section>
      )}

      {editing && <ReviewDialog card={editing} settings={settings} onClose={() => setEditing(null)} onApproved={async () => { setEditing(null); await reload(); }} />}
      <ConfirmDialog
        open={!!revoking} title="Revoke this link?" description="Anyone with the link will see that the card is no longer available. This cannot be undone."
        confirmLabel="Revoke link" onCancel={() => setRevoking(null)}
        onConfirm={async () => { if (!revoking) return; const r = await revokeWinCard(revoking.id); setRevoking(null); if (!r.ok) toast(r.error, 'error'); else toast('Link revoked', 'success'); await reload(); }}
      />
    </div>
  );
}

function ReviewDialog({ card, settings, onClose, onApproved }: { card: WinCard; settings: WinCardSettings | null; onClose: () => void; onApproved: () => void }) {
  const { toast } = useToast();
  const [sel, setSel] = useState<Selection>({ ...DEFAULT_SELECTION, showCta: settings?.show_cta ?? true });
  const [theme, setTheme] = useState<Theme>(settings?.theme ?? 'light');
  const [fmt, setFmt] = useState<'og' | 'square' | 'story'>('square');
  const [prev, setPrev] = useState<{ svg: Record<string, string>; captions: string[]; err: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const hasValue = !!card.private_facts.valueCents;

  useEffect(() => {
    let off = false;
    const t = setTimeout(async () => {
      const r = await previewWinCard(card.id, sel, theme);
      if (off) return;
      setPrev(r.ok ? { svg: r.data.previews, captions: r.data.captions, err: null } : { svg: prev?.svg ?? {}, captions: prev?.captions ?? [], err: r.error });
    }, 250);
    return () => { off = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, sel, theme]);

  const toggle = (k: keyof Selection) => setSel((s) => ({ ...s, [k]: !s[k] }));
  const approve = async () => {
    setBusy(true);
    const r = await approveWinCard(card.id, sel, theme);
    setBusy(false);
    if (!r.ok) return void toast(r.error, 'error');
    toast('Card approved. Your link is ready.', 'success');
    onApproved();
  };
  const row = (k: keyof Selection, label: string, disabled = false) => (
    <label className={`flex items-center gap-2 text-sm ${disabled ? 'opacity-50' : ''}`}><input type="checkbox" disabled={disabled} checked={!!sel[k]} onChange={() => toggle(k)} /> {label}</label>
  );

  return (
    <div role="dialog" aria-modal="true" aria-label="Review win card" className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div className="w-full max-w-4xl rounded-2xl bg-bg-primary p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-text-primary">Review: {LABEL[card.trigger_type]}</h2>
        <p className="text-sm text-text-secondary">This preview is the exact card that will be public. Everything not ticked stays private.</p>
        <div className="mt-4 grid gap-6 md:grid-cols-[1fr_280px]">
          <div>
            <div className="mb-2 flex gap-2" role="tablist" aria-label="Card size">
              {(['square', 'og', 'story'] as const).map((f) => (
                <button key={f} role="tab" aria-selected={fmt === f} onClick={() => setFmt(f)} className={`focus-ring rounded-lg px-3 py-1 text-xs ${fmt === f ? 'bg-accent text-white' : 'border border-border text-text-secondary'}`}>{f === 'square' ? '1080×1080' : f === 'og' ? '1200×630' : '1080×1920 story'}</button>
              ))}
            </div>
            {prev?.svg[fmt] ? <img src={dataUri(prev.svg[fmt])} alt="Preview of the public card" className="max-h-[60vh] w-full rounded-xl border border-border object-contain" /> : <div className="h-64 animate-pulse rounded-xl bg-bg-tertiary" />}
            {prev?.err && <p role="alert" className="mt-2 text-sm text-red-600">{prev.err}</p>}
          </div>
          <div className="space-y-3">
            <fieldset className="space-y-2"><legend className="mb-1 text-sm font-medium text-text-primary">Show on the card</legend>
              {row('showValue', hasValue ? 'Job value (rounded down)' : 'Job value (none recorded)', !hasValue)}
              {row('showTimeBucket', 'Time of day (for example “Overnight”)')}
              {row('showMonth', 'Month and year')}
              {row('showBusinessName', 'Business name', !settings?.show_business_name)}
              {row('showCta', '“See how it works” button', !settings?.show_cta)}
            </fieldset>
            <label className="block text-sm text-text-secondary">Service label (optional, no names)
              <input maxLength={40} value={sel.serviceLabel ?? ''} onChange={(e) => setSel((s) => ({ ...s, serviceLabel: e.target.value || null }))} className="focus-ring mt-1 w-full rounded-lg border border-border bg-bg-secondary px-2 py-1.5" />
            </label>
            <label className="block text-sm text-text-secondary">Caption
              <textarea maxLength={280} rows={3} value={sel.caption ?? ''} onChange={(e) => setSel((s) => ({ ...s, caption: e.target.value || null }))} className="focus-ring mt-1 w-full rounded-lg border border-border bg-bg-secondary px-2 py-1.5" />
            </label>
            {prev && prev.captions.length > 0 && (
              <div className="space-y-1"><p className="text-xs text-text-secondary">Suggestions</p>
                {prev.captions.map((c) => <button key={c} type="button" onClick={() => setSel((s) => ({ ...s, caption: c }))} className="focus-ring block w-full rounded-lg border border-border p-2 text-left text-xs text-text-secondary hover:text-text-primary">{c}</button>)}
              </div>
            )}
            <label className="flex items-center gap-2 text-sm text-text-secondary">Look
              <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)} className="focus-ring rounded-lg border border-border bg-bg-secondary px-2 py-1"><option value="light">Light</option><option value="dark">Dark</option></select>
            </label>
            <p className="text-xs text-text-secondary">Link expires after {settings?.default_expiry_days ?? 30} days. You can revoke it at any time.</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="focus-ring rounded-xl border border-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary">Cancel</button>
          <button type="button" onClick={approve} disabled={busy || !!prev?.err || !prev} className="focus-ring rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{busy ? 'Approving…' : 'Approve and create link'}</button>
        </div>
      </div>
    </div>
  );
}

function LiveCard({ card, origin, onRevoke, onChanged }: { card: WinCard; origin: string; onRevoke: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [chatTargets, setChatTargets] = useState<ChatTarget[] | null>(null);
  const [pick, setPick] = useState('');
  const [posting, setPosting] = useState(false);
  const pub = card.public_fields;
  const token = card.token ?? '';
  const url = useMemo(() => winCardUrl(origin, token), [origin, token]);
  const text = pub?.caption ?? pub?.headline ?? '';
  const targets = useMemo(() => (token && pub ? buildShareTargets(url, text) : null), [url, text, token, pub]);
  const suspended = card.status === 'suspended';
  const count = (ch: string) => void recordWinCardShare(card.id, ch);
  const copy = async (s: string, ch: string) => { await navigator.clipboard.writeText(s); count(ch); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const open = (href: string, ch: string) => { count(ch); window.open(href, '_blank', 'noopener,noreferrer'); };
  if (!pub || !targets) return null;
  const expired = !!card.expires_at && new Date(card.expires_at) < new Date();

  return (
    <li className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap gap-4">
        <img src={winCardImageUrl(origin, token, 'square', 'svg')} alt={pub.headline} width={140} height={140} className="h-[140px] w-[140px] rounded-xl border border-border" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium text-text-primary">{pub.headline}</p>
          <p className="text-xs text-text-secondary">
            {suspended ? 'Suspended after reports. The link is offline.' : expired ? 'Expired' : `Expires ${new Date(card.expires_at ?? '').toLocaleDateString()}`} · {card.view_count} views · {card.cta_count} clicks · {card.report_count} reports
          </p>
          {!suspended && !expired && (
            <div className="flex flex-wrap gap-2">
              {'share' in navigator && <button type="button" onClick={() => navigator.share({ title: pub.headline, text, url }).then(() => count('native')).catch(() => undefined)} className="focus-ring inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs"><Share2 size={14} aria-hidden="true" /> Share</button>}
              <button type="button" onClick={() => copy(url, 'link')} className="focus-ring inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs">{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} Copy link</button>
              <a href={winCardImageUrl(origin, token, 'square', 'png')} download="win-card-1080x1080.png" className="focus-ring inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs"><Download size={14} aria-hidden="true" /> PNG 1080</a>
              <a href={winCardImageUrl(origin, token, 'story', 'png')} download="win-card-story.png" className="focus-ring inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs"><Download size={14} aria-hidden="true" /> Story</a>
              <a href={winCardImageUrl(origin, token, 'square', 'svg')} download="win-card.svg" className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs">SVG</a>
              <button type="button" onClick={() => open(targets.linkedin, 'linkedin')} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs">LinkedIn</button>
              <button type="button" onClick={() => open(targets.facebook, 'facebook')} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs">Facebook</button>
              <button type="button" onClick={() => open(targets.x, 'x')} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs">X</button>
              <button type="button" onClick={() => copy(text, 'instagram').then(() => toast(INSTAGRAM_HINT, 'info'))} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs">Instagram</button>
              <button type="button" onClick={() => copy(slackMessage(pub.headline, pub.caption, url), 'slack').then(() => toast('Copied for Slack. Paste it in a channel.', 'success'))} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs">Copy for Slack</button>
              <button type="button" onClick={() => open(targets.teams, 'teams')} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs">Teams</button>
              <button type="button" onClick={async () => { const r = await winCardChatTargets(); if (!r.ok) return void toast(r.error, 'error'); setChatTargets(r.data.targets); if (!r.data.targets.some((t) => t.channels.length)) toast('Connect Slack or Teams and pick a channel in Integrations first.', 'info'); }} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs">Post to team chat</button>
              <button type="button" onClick={async () => { const r = await extendWinCard(card.id, 30); if (!r.ok) toast(r.error, 'error'); else { toast('Extended by 30 days from today', 'success'); onChanged(); } }} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs">Extend 30 days</button>
            </div>
          )}
          {targets && targets.some((t) => t.channels.length) && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-text-secondary">Channel
                <select value={pick} onChange={(e) => setPick(e.target.value)} className="focus-ring ml-2 rounded-lg border border-border bg-bg-primary px-2 py-1 text-xs">
                  <option value="">Choose…</option>
                  {targets.flatMap((t) => t.channels.map((ch) => <option key={`${t.connectionId}|${ch.id}`} value={`${t.connectionId}|${ch.id}`}>{t.provider === 'slack' ? 'Slack' : 'Teams'} · {ch.name}</option>))}
                </select>
              </label>
              <button type="button" disabled={!pick || posting} onClick={async () => { const [cid, ch] = pick.split('|'); setPosting(true); const r = await postWinCardToChat(card.id, cid, ch); setPosting(false); if (!r.ok) toast(r.error, 'error'); else toast('Posted to your team chat', 'success'); }} className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60">{posting ? 'Posting…' : 'Post'}</button>
            </div>
          )}
          <button type="button" onClick={onRevoke} className="focus-ring rounded-lg px-1 py-1 text-xs text-red-600 underline underline-offset-4">Revoke link</button>
        </div>
      </div>
    </li>
  );
}
