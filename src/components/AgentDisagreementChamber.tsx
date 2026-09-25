import { useCallback, useEffect, useState } from 'react';
import type { AgentPosition, ChamberCase, CeoDecision, Stance } from '@/lib/agentChamber';
import {
  conveneCampaignChamber,
  decideChamberCase,
  fetchRecentChamberCases,
  type SavedChamberSummary,
} from '@/lib/agentChamberApi';

const STANCE_LABEL: Record<Stance, string> = { support: 'Supports', conditional: 'Conditional', oppose: 'Opposes' };
const STANCE_STYLE: Record<Stance, string> = {
  support: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  conditional: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  oppose: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
};
const ACTION_LABEL: Record<CeoDecision['action'], string> = { launch: 'Launch', launch_capped: 'Launch capped', defer: 'Defer' };
const ACTION_STYLE: Record<CeoDecision['action'], string> = {
  launch: 'bg-emerald-600 text-white',
  launch_capped: 'bg-amber-500 text-slate-900',
  defer: 'bg-slate-700 text-white dark:bg-slate-300 dark:text-slate-900',
};

const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
const errorText = (e: unknown) => (e as { message?: string } | null)?.message ?? 'Something went wrong.';

function PositionCard({ p }: { p: AgentPosition }) {
  return (
    <article className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{p.agentName}</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STANCE_STYLE[p.stance]}`}>{STANCE_LABEL[p.stance]}</span>
      </div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Optimises: {p.objective}</p>
      <p className="mt-2 text-sm">
        <span className="font-medium">Proposal:</span> {p.proposal}
      </p>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{p.reason}</p>
    </article>
  );
}

interface Props {
  ownerId: string;
}

export default function AgentDisagreementChamber({ ownerId }: Props) {
  const [name, setName] = useState('');
  const [audience, setAudience] = useState('500');
  const [conversion, setConversion] = useState('');
  const [result, setResult] = useState<{ id: string; case: ChamberCase } | null>(null);
  const [note, setNote] = useState('');
  const [history, setHistory] = useState<SavedChamberSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await fetchRecentChamberCases(ownerId));
    } catch (e) {
      setError(errorText(e));
    }
  }, [ownerId]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  const convene = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await conveneCampaignChamber(ownerId, {
        campaignName: name,
        audienceSize: Number(audience) || 0,
        conversionPct: conversion.trim() === '' ? null : Number(conversion),
      });
      setResult({ id: out.id, case: out.case });
      setNote('');
      await refreshHistory();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: 'accepted' | 'overridden') => {
    if (!result) return;
    if (decision === 'overridden' && note.trim() === '') {
      setError('Write a reason before overriding the CEO agent.');
      return;
    }
    try {
      await decideChamberCase(result.id, decision, decision === 'overridden' ? note.trim() : null);
      setError(null);
      await refreshHistory();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const c = result?.case;

  return (
    <section aria-labelledby="chamber-title" className="rounded-xl border border-slate-200 p-5 dark:border-slate-700">
      <h2 id="chamber-title" className="text-lg font-semibold">Agent Disagreement Chamber</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Every agent’s position is shown, including the ones that disagree. The CEO agent recommends; you decide.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <label className="text-sm sm:col-span-2">
          Campaign name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Spring tune-up"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-900" />
        </label>
        <label className="text-sm">
          Contacts reached
          <input type="number" min={0} value={audience} onChange={(e) => setAudience(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-900" />
        </label>
        <label className="text-sm">
          Booking rate (%)
          <input type="number" min={0} max={100} value={conversion} placeholder="from history"
            onChange={(e) => setConversion(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-900" />
        </label>
      </div>
      <button type="button" onClick={() => void convene()} disabled={busy}
        className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
        Convene the chamber
      </button>

      {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {c && result && (
        <div className="mt-6 space-y-5">
          <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <div className="flex flex-wrap items-center gap-3">
              <span className={`rounded-full px-2.5 py-0.5 text-sm font-medium ${ACTION_STYLE[c.ceo.action]}`}>
                {ACTION_LABEL[c.ceo.action]}
              </span>
              <h3 className="font-semibold">CEO Agent: {c.ceo.headline}</h3>
              <span className="text-xs text-slate-500">Confidence: {c.ceo.confidence}</span>
            </div>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
              {c.ceo.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {c.positions.map((p) => <PositionCard key={p.role} p={p} />)}
          </div>

          {c.conflicts.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold">Conflicts</h3>
              <ul className="mt-2 space-y-2 text-sm">
                {c.conflicts.map((x) => <li key={x.description} className="text-slate-700 dark:text-slate-300">{x.description}</li>)}
              </ul>
            </div>
          )}

          <div>
            <h3 className="text-sm font-semibold">Trade-off</h3>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1 font-normal">Option</th>
                  <th className="py-1 font-normal">Bookings</th>
                  <th className="py-1 font-normal">Revenue</th>
                  <th className="py-1 font-normal">Technician hours</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-slate-200 dark:border-slate-700">
                  <td className="py-1">Full launch</td>
                  <td>{c.tradeoff.fullBookings}</td>
                  <td>{dollars(c.tradeoff.fullRevenueCents)}</td>
                  <td>{c.tradeoff.hoursNeeded}h needed / {c.tradeoff.hoursUsable}h usable</td>
                </tr>
                <tr className="border-t border-slate-200 dark:border-slate-700">
                  <td className="py-1">Capacity-capped</td>
                  <td>{c.tradeoff.cappedBookings}</td>
                  <td>{dollars(c.tradeoff.cappedRevenueCents)}</td>
                  <td>up to {c.tradeoff.hoursUsable}h</td>
                </tr>
              </tbody>
            </table>
            {c.tradeoff.marginCents !== null && (
              <p className="mt-2 text-xs text-slate-500">Expected gross margin on the full launch: {dollars(c.tradeoff.marginCents)}.</p>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <p className="text-sm font-medium">Your decision</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => void decide('accepted')}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white">
                Accept CEO recommendation
              </button>
            </div>
            <label className="mt-3 block text-sm">
              Or override with a reason
              <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-900" />
            </label>
            <button type="button" onClick={() => void decide('overridden')}
              className="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600">
              Record override
            </button>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">Recent cases</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap justify-between gap-2 text-slate-600 dark:text-slate-400">
                <span>{h.title}</span>
                <span>
                  {ACTION_LABEL[h.ceo.action as CeoDecision['action']] ?? h.ceo.action}
                  {h.owner_decision ? ` · ${h.owner_decision}` : ' · undecided'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
