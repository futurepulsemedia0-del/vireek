import { useCallback, useEffect, useState } from 'react';
import { MapPinned, Loader as Loader2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { FIELD, TerritoryShapeFields, emptyShape, shapeFromDraft, type ShapeDraft } from '@/components/territory/TerritoryShapeFields';
import { INDUSTRIES } from '@/lib/industries';
import { parseZipList } from '@/lib/territoryExclusivity/core';
import { cancelWaitlist, fetchMyTerritories, friendlyTerritoryError, joinWaitlist, marketingGuard, respondToOffer, type MyTerritory, type MyWait } from '@/lib/territoryExclusivity/api';

const LABEL = 'Exclusive territories';
const BOX = 'rounded-xl border border-border p-4';
const fmt = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: iso.length > 10 ? 'short' : undefined }).format(new Date(iso));

export function TerritoriesPage() {
  const { toast } = useToast();
  const [state, setState] = useState<{ territories: MyTerritory[]; waitlist: MyWait[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [wlLabel, setWlLabel] = useState('');
  const [wlShape, setWlShape] = useState<ShapeDraft>(emptyShape());
  const [gTrade, setGTrade] = useState(emptyShape().trade);
  const [gText, setGText] = useState('');
  const [gResult, setGResult] = useState<{ checked: number; blocked: string[] } | null>(null);

  const load = useCallback(async () => { try { setState(await fetchMyTerritories()); setFailed(false); } catch { setFailed(true); } }, []);
  useEffect(() => { void load(); }, [load]);
  const run = async (tag: string, fn: () => Promise<string | void>) => {
    setBusy(tag);
    try { const m = await fn(); if (m) toast(m, 'success'); await load(); } catch (e) { toast(friendlyTerritoryError(e), 'error'); } finally { setBusy(null); }
  };

  if (failed) return <DashboardLayout activeLabel={LABEL}><p role="alert" className="p-6 text-sm">Territories are visible to owners and admins only, or could not be loaded.</p></DashboardLayout>;
  if (!state) return <DashboardLayout activeLabel={LABEL}><p role="status" className="p-6 text-sm text-text-secondary"><Loader2 size={14} className="mr-1.5 inline animate-spin" />Loading…</p></DashboardLayout>;
  const parsedWl = shapeFromDraft(wlShape);

  return (
    <DashboardLayout activeLabel={LABEL}>
      <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-semibold"><MapPinned size={22} aria-hidden="true" /> Exclusive territories</h1>
          <p className="mt-1 text-sm text-text-secondary">Areas where your business is the only Vireek customer for a trade. Territories are granted by Vireek under a separate agreement (terms: TODO(counsel)).</p>
        </header>

        <Card className="space-y-3 p-5">
          <h2 className="text-base font-semibold">Your territories</h2>
          {state.territories.length === 0 ? <p className="text-sm text-text-secondary">You do not hold an exclusive territory yet. Join the waiting list below to ask for one.</p> : (
            <ul className="space-y-2">{state.territories.map((t) => (
              <li key={t.id} className={BOX}>
                <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{t.label} · {t.trade}</span><span className="text-xs font-semibold uppercase">{t.status === 'suspended' ? 'Paused (still reserved)' : t.status}</span></div>
                <p className="mt-1 text-xs text-text-secondary">{t.zone_type === 'zip' ? `${t.zip_codes.length} code(s)` : 'Polygon area'} · {fmt(t.term_start)} → {fmt(t.term_end)}{t.contract_reference ? ` · ${t.contract_reference}` : ''}{t.auto_renew ? ' · renewal handled by Vireek staff' : ''}</p>
              </li>))}</ul>
          )}
        </Card>

        <Card className="space-y-3 p-5">
          <h2 className="text-base font-semibold">Waiting list</h2>
          {state.waitlist.length === 0 ? <p className="text-sm text-text-secondary">No open requests.</p> : (
            <ul className="space-y-2">{state.waitlist.map((w) => (
              <li key={w.id} className={BOX}>
                <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{w.label} · {w.trade}</span><span className="text-xs font-semibold uppercase">{w.status}</span></div>
                {w.status === 'offered' && w.offer_expires_at && <p role="status" className="mt-1 text-sm">This territory is available for you until {fmt(w.offer_expires_at)}.</p>}
                <div className="mt-2 flex gap-2">
                  {w.status === 'offered' && <><Button size="sm" disabled={!!busy} onClick={() => void run(`y${w.id}`, async () => { await respondToOffer(w.id, true); return 'Accepted. Vireek will contact you with the agreement.'; })}>Accept</Button><Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run(`n${w.id}`, async () => { await respondToOffer(w.id, false); })}>Decline</Button></>}
                  {w.status !== 'accepted' && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run(`c${w.id}`, async () => { await cancelWaitlist(w.id); return 'Request cancelled.'; })}>Cancel request</Button>}
                </div>
              </li>))}</ul>
          )}
          <h3 className="pt-2 text-sm font-semibold">Ask for a territory</h3>
          <div><label htmlFor="wl-label" className="mb-1 block text-sm font-medium">Name</label><input id="wl-label" maxLength={80} className={FIELD} value={wlLabel} onChange={(e) => setWlLabel(e.target.value)} /></div>
          <TerritoryShapeFields idPrefix="wl" value={wlShape} onChange={setWlShape} />
          {'error' in parsedWl && wlShape.zipText + wlShape.polyText !== '' && <p className="text-xs text-text-secondary">{parsedWl.error}</p>}
          <Button disabled={!!busy || !wlLabel.trim() || 'error' in parsedWl} onClick={() => void run('join', async () => { if ('shape' in parsedWl) await joinWaitlist(wlLabel.trim(), parsedWl.shape); setWlLabel(''); setWlShape(emptyShape()); return 'Added to the waiting list.'; })}>Join waiting list</Button>
        </Card>

        <Card className="space-y-3 p-5">
          <h2 className="text-base font-semibold">Marketing check</h2>
          <p className="text-sm text-text-secondary">Before you target ZIP codes in ads or campaigns, see which are exclusively held by another Vireek customer for the same trade. We never say who.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div><label htmlFor="g-trade" className="mb-1 block text-sm font-medium">Trade</label><select id="g-trade" className={FIELD} value={gTrade} onChange={(e) => setGTrade(e.target.value)}>{INDUSTRIES.map((i) => <option key={i.slug} value={i.slug}>{i.slug}</option>)}</select></div>
            <div className="sm:col-span-2"><label htmlFor="g-zips" className="mb-1 block text-sm font-medium">ZIP / postal codes</label><input id="g-zips" className={FIELD} value={gText} onChange={(e) => setGText(e.target.value)} placeholder="10001, 10002" /></div>
          </div>
          <Button variant="secondary" disabled={!!busy || !gText.trim()} onClick={() => void run('guard', async () => { const { codes } = parseZipList(gText); const r = await marketingGuard(gTrade, codes); setGResult({ checked: r.checked, blocked: r.blocked_zips }); })}>Check</Button>
          {gResult && <p role="status" className="text-sm">{gResult.blocked.length === 0 ? `${gResult.checked} code(s) checked — none are exclusively held by someone else.` : `Exclusively held by another customer: ${gResult.blocked.join(', ')}. Do not target these.`}</p>}
        </Card>
      </div>
    </DashboardLayout>
  );
}
