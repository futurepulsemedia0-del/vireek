import { useEffect, useMemo, useState } from 'react';
import { Loader2, ShieldCheck, X } from 'lucide-react';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  centsToDollarsInput,
  dollarsToCents,
  formatPrice,
  scopesAddedBy,
  type MarketplaceAgent,
  type MarketplaceInstall,
  type MarketplaceScope,
  type MarketplaceVersion,
} from '@/lib/agentMarketplace';

const RISK_STYLES = {
  low: 'bg-success-500/10 text-success-500',
  medium: 'bg-warning-500/10 text-warning-500',
  high: 'bg-danger/10 text-danger',
} as const;

interface InstallDialogProps {
  open: boolean;
  agent: MarketplaceAgent | null;
  version: MarketplaceVersion | null;
  scopes: MarketplaceScope[];
  /** Present when editing / upgrading an existing install. */
  install?: MarketplaceInstall | null;
  onCancel: () => void;
  onSubmit: (values: { scopes: string[]; maxRunsPerDay: number; maxMonthlySpendCents: number }) => Promise<void>;
}

export function InstallDialog({ open, agent, version, scopes, install, onCancel, onSubmit }: InstallDialogProps) {
  const dialogRef = useFocusTrap(open);
  useEscapeToClose(open, onCancel);

  const requested = useMemo(() => version?.manifest.scopes ?? [], [version]);
  const scopeInfo = useMemo(() => new Map(scopes.map((s) => [s.slug, s])), [scopes]);

  const [granted, setGranted] = useState<string[]>([]);
  const [runs, setRuns] = useState('100');
  const [spend, setSpend] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !agent) return;
    setError(null);
    if (install) {
      setGranted(install.granted_scopes.filter((s) => requested.includes(s)));
      setRuns(String(install.max_runs_per_day));
      setSpend(centsToDollarsInput(install.max_monthly_spend_cents));
    } else {
      // Least privilege by default: pre-select only low-risk scopes.
      setGranted(requested.filter((s) => scopeInfo.get(s)?.risk === 'low'));
      setRuns('100');
      const minSpend = agent.pricing_model === 'monthly' ? agent.price_cents : agent.pricing_model === 'per_run' ? agent.price_cents * 100 : 0;
      setSpend(centsToDollarsInput(minSpend));
    }
  }, [open, agent, install, requested, scopeInfo]);

  if (!open || !agent || !version) return null;

  const newScopes = install ? scopesAddedBy(install.granted_scopes, requested) : [];
  const toggle = (slug: string) => setGranted((g) => (g.includes(slug) ? g.filter((s) => s !== slug) : [...g, slug]));

  const submit = async () => {
    const runsNum = Number(runs);
    const spendCents = dollarsToCents(spend);
    if (!Number.isInteger(runsNum) || runsNum < 1 || runsNum > 10000) return setError('Runs per day must be a whole number from 1 to 10,000.');
    if (spendCents === null) return setError('Enter the monthly spend cap in dollars, for example 25 or 25.50.');
    if (granted.length === 0) return setError('Grant at least one permission, or cancel.');
    if (agent.pricing_model === 'monthly' && spendCents < agent.price_cents) return setError('The spend cap is lower than this agent’s monthly price.');
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({ scopes: granted, maxRunsPerDay: runsNum, maxMonthlySpendCents: spendCents });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

  return (
    <>
      <div className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm" onClick={onCancel} aria-hidden="true" />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-dialog-title"
        className="fixed left-1/2 top-1/2 z-[120] max-h-[90vh] w-[94vw] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="install-dialog-title" className="flex items-center gap-2 text-base font-semibold text-text-primary">
              <ShieldCheck size={18} className="text-cta" /> {install ? 'Permissions for' : 'Install'} {agent.name}
            </h2>
            <p className="mt-1 text-xs text-text-secondary">
              by {agent.publisher_name} · v{version.version} · {formatPrice(agent)}
            </p>
          </div>
          <button onClick={onCancel} aria-label="Close" className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary"><X size={16} /></button>
        </div>

        {newScopes.length > 0 && (
          <p className="mb-3 rounded-xl bg-warning-500/10 p-3 text-xs text-warning-500">
            This version asks for new permissions: {newScopes.map((s) => scopeInfo.get(s)?.label ?? s).join(', ')}. Review them below.
          </p>
        )}

        <p className="mb-2 text-xs font-medium text-text-secondary">This agent is asking for:</p>
        <div className="mb-4 space-y-2">
          {requested.map((slug) => {
            const info = scopeInfo.get(slug);
            const checked = granted.includes(slug);
            return (
              <label key={slug} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-bg-primary p-3">
                <input type="checkbox" className="mt-1" checked={checked} onChange={() => toggle(slug)} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
                    {info?.label ?? slug}
                    {info && <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${RISK_STYLES[info.risk]}`}>{info.risk} risk</span>}
                  </span>
                  <span className="block text-xs text-text-secondary">{info?.description ?? slug}</span>
                </span>
              </label>
            );
          })}
        </div>

        <div className="mb-2 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-text-secondary">
            Max runs per day
            <input className={`${inputCls} mt-1`} inputMode="numeric" value={runs} onChange={(e) => setRuns(e.target.value)} />
          </label>
          <label className="text-xs text-text-secondary">
            Monthly spend cap (USD)
            <input className={`${inputCls} mt-1`} inputMode="decimal" value={spend} onChange={(e) => setSpend(e.target.value)} />
          </label>
        </div>
        <p className="mb-4 text-[11px] text-text-secondary">
          Anything an agent wants to do on the “act” permissions still goes through Agent Governance (approvals, limits, audit). You can pause or revoke this agent at any time.
        </p>

        {error && <p role="alert" className="mb-3 rounded-xl bg-danger/10 p-3 text-xs text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="focus-ring rounded-xl bg-bg-tertiary px-4 py-2 text-sm font-medium text-text-secondary">Cancel</button>
          <button disabled={submitting} onClick={submit} className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {install ? 'Save permissions' : 'Install agent'}
          </button>
        </div>
      </div>
    </>
  );
}
