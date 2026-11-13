// Recreated: verify against original intent
// /dashboard/governance
//
// One overview of how automation is governed: the Business Constitution (rules and blocked attempts) and the
// agent authority matrix (what each agent may do, what needs approval, which actions are red lines). Everything is
// read-only here and comes from the existing constitution API; each card links to the page where it is managed.
// TODO(vireek): the original page may have shown more panels; only what the repository can back is shown.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  fetchArticles,
  fetchAuthorityMatrix,
  fetchViolations,
  type AuthorityMatrixRow,
  type ConstitutionArticle,
  type ConstitutionViolation,
} from '@/lib/constitution';

interface Snapshot {
  articles: ConstitutionArticle[];
  violations: ConstitutionViolation[];
  matrix: AuthorityMatrixRow[];
}

const card = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const LINKS: { to: string; label: string; hint: string }[] = [
  { to: '/dashboard/constitution', label: 'Business Constitution', hint: 'Write the rules every agent must follow.' },
  { to: '/dashboard/agent-governance', label: 'Agent Governance', hint: 'Set what each agent may do and when a person must approve.' },
  { to: '/dashboard/agent-actions', label: 'Agent Actions', hint: 'Review requests waiting for approval.' },
  { to: '/dashboard/ai-reliability', label: 'AI Reliability', hint: 'Decision quality, reviews and calibration.' },
  { to: '/dashboard/security-center', label: 'AI Security Center', hint: 'Prompt-injection and abuse protection.' },
];
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function GovernanceCenterPage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(false);
    try {
      const [articles, violations, matrix] = await Promise.all([fetchArticles(), fetchViolations(), fetchAuthorityMatrix()]);
      if (mine === seq.current) setSnap({ articles, violations, matrix });
    } catch {
      if (mine === seq.current) setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => { seq.current++; };
  }, [load]);

  const stats = useMemo(() => {
    if (!snap) return null;
    const open = snap.violations.filter((v) => !v.overridden);
    return {
      activeRules: snap.articles.filter((a) => a.enabled).length,
      totalRules: snap.articles.length,
      blocked: snap.violations.length,
      overridden: snap.violations.length - open.length,
      redLines: snap.matrix.filter((m) => m.is_red_line),
      needApproval: snap.matrix.filter((m) => m.enabled && m.requires_approval && !m.is_red_line).length,
      autonomous: snap.matrix.filter((m) => m.enabled && !m.requires_approval && !m.is_red_line).length,
      disabled: snap.matrix.filter((m) => !m.enabled).length,
      recent: [...snap.violations].sort((a, b) => Date.parse(b.blocked_at) - Date.parse(a.blocked_at)).slice(0, 5),
    };
  }, [snap]);

  return (
    <DashboardLayout activeLabel="Governance Center">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><ShieldAlert size={22} aria-hidden="true" /> Governance Center</h1>
        <p className="mt-1 text-sm text-text-secondary">How your automation is governed, in one place.</p>
      </div>

      {error && <p role="alert" className="mb-4 rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger">Could not load governance data. <button type="button" onClick={() => void load()} className="focus-ring font-semibold underline">Try again</button></p>}
      {!snap && !error && <p role="status" className="py-6 text-sm text-text-secondary">Loading…</p>}

      {stats && (
        <>
          <dl className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ['Active rules', `${stats.activeRules} of ${stats.totalRules}`],
              ['Attempts blocked', String(stats.blocked)],
              ['Need human approval', String(stats.needApproval)],
              ['Run on their own', String(stats.autonomous)],
            ].map(([k, v]) => <div key={k} className={card}><dt className="text-xs font-semibold text-text-secondary">{k}</dt><dd className="mt-1 text-xl font-bold text-text-primary">{v}</dd></div>)}
          </dl>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className={card} aria-labelledby="gov-red">
              <h2 id="gov-red" className="text-base font-semibold text-text-primary">Red lines</h2>
              <p className="mt-0.5 text-xs text-text-secondary">Actions no agent may take, whatever its settings.</p>
              {stats.redLines.length === 0 ? <p className="mt-3 text-sm text-text-secondary">None set.</p> : (
                <ul className="mt-3 divide-y divide-border rounded-xl border border-border text-sm">
                  {stats.redLines.map((r) => <li key={r.action_slug} className="px-3 py-2"><p className="font-medium text-text-primary">{r.label}</p>{r.red_line_reason && <p className="text-xs text-text-secondary">{r.red_line_reason}</p>}</li>)}
                </ul>
              )}
              {stats.disabled > 0 && <p className="mt-3 text-xs text-text-secondary">{stats.disabled} further action{stats.disabled === 1 ? ' is' : 's are'} switched off.</p>}
            </section>

            <section className={card} aria-labelledby="gov-recent">
              <h2 id="gov-recent" className="text-base font-semibold text-text-primary">Recently blocked</h2>
              {stats.recent.length === 0 ? <p className="mt-3 text-sm text-text-secondary">Nothing has been blocked.</p> : (
                <ul className="mt-3 divide-y divide-border rounded-xl border border-border text-sm">
                  {stats.recent.map((v) => (
                    <li key={v.id} className="px-3 py-2">
                      <p className="break-words font-medium text-text-primary">{v.action_type.replace(/_/g, ' ')}</p>
                      <p className="break-words text-xs text-text-secondary">{v.reason}</p>
                      <p className="text-xs text-text-secondary">{day(v.blocked_at)}{v.overridden ? ' · overridden by a person' : ''}</p>
                    </li>
                  ))}
                </ul>
              )}
              {stats.overridden > 0 && <p className="mt-3 text-xs text-text-secondary">{stats.overridden} block{stats.overridden === 1 ? ' was' : 's were'} overridden by a person.</p>}
            </section>
          </div>
        </>
      )}

      <section className={`${card} mt-6`} aria-labelledby="gov-manage">
        <h2 id="gov-manage" className="text-base font-semibold text-text-primary">Manage</h2>
        <ul className="mt-3 grid gap-2 md:grid-cols-2">
          {LINKS.map((l) => (
            <li key={l.to}><Link to={l.to} className="focus-ring block rounded-xl border border-border p-3 hover:bg-bg-tertiary"><span className="block text-sm font-semibold text-text-primary">{l.label}</span><span className="block text-xs text-text-secondary">{l.hint}</span></Link></li>
          ))}
        </ul>
      </section>
    </DashboardLayout>
  );
}
