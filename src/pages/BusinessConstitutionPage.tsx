/**
 * Business Constitution Simulator — /dashboard/constitution
 * Owner-defined non-negotiable rules, checked before automated actions run.
 */

import { useCallback, useEffect, useState } from 'react';
import { Scale, Loader2, Plus, Trash2, ShieldAlert } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  RULE_TEMPLATES,
  createArticle,
  deleteArticle,
  fetchArticles,
  fetchActionCatalog,
  fetchAuthorityMatrix,
  fetchViolations,
  overrideViolation,
  toggleArticle,
  type AgentCatalogEntry,
  type AuthorityMatrixRow,
  type ConstitutionArticle,
  type ConstitutionViolation,
  type RuleType,
} from '@/lib/constitution';
export function BusinessConstitutionPage() {
  const { toast } = useToast();
  const [articles, setArticles] = useState<ConstitutionArticle[]>([]);
  const [violations, setViolations] = useState<ConstitutionViolation[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState<RuleType>('no_campaign_if_sla_at_risk');
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [catalog, setCatalog] = useState<AgentCatalogEntry[]>([]);
  const [authorityMatrix, setAuthorityMatrix] = useState<AuthorityMatrixRow[]>([]);

  const template = RULE_TEMPLATES.find((t) => t.rule_type === selectedTemplate);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, v, c, m] = await Promise.all([fetchArticles(), fetchViolations(), fetchActionCatalog(), fetchAuthorityMatrix()]);
      setArticles(a); setViolations(v); setCatalog(c); setAuthorityMatrix(m);
    } catch {
      toast('Could not load the constitution.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const handleAdd = async () => {
    try {
      const params: Record<string, unknown> = {};
      for (const p of template?.params ?? []) {
        const raw = paramValues[p.key];
        params[p.key] = p.type === 'number' ? Number(raw || p.defaultValue) : (raw || p.defaultValue);
      }
      await createArticle(selectedTemplate, params);
      setParamValues({}); toast('Article added to the constitution.', 'success'); void load();
    } catch {
      toast('Could not add this article.', 'error');
    }
  };

  const handleOverride = async (id: string) => {
    const reason = window.prompt('Reason for overriding this block (required):');
    if (!reason) return;
    try {
      await overrideViolation(id, reason);
      toast('Override logged.', 'success'); void load();
    } catch {
      toast('Could not override.', 'error');
    }
  };

  if (loading) {
    return <DashboardLayout activeLabel="Business Constitution"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout activeLabel="Business Constitution">
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-2">
          <Scale className="text-cta" size={20} />
          <p className="text-sm font-semibold text-text-primary">Business Constitution</p>
        </div>

        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Add a non-negotiable principle</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <select className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary sm:col-span-2"
              value={selectedTemplate} onChange={(e) => { setSelectedTemplate(e.target.value as RuleType); setParamValues({}); }}>
              {RULE_TEMPLATES.map((t) => <option key={t.rule_type} value={t.rule_type}>{`[${t.riskTier}] ${t.label}`}</option>)}
            </select>
            {template?.params?.map((p) => (
              p.type === 'select' ? (
                <select key={p.key} className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                  value={paramValues[p.key] ?? String(p.defaultValue ?? '')}
                  onChange={(e) => setParamValues((v) => ({ ...v, [p.key]: e.target.value }))}>
                  {(p.key === 'action_slug' ? catalog.map((c) => ({ value: c.slug, label: `${c.label} (${c.agent_source})` })) : p.options ?? [])
                    .map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <input key={p.key} className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                  type="number" placeholder={p.label} value={paramValues[p.key] ?? ''}
                  onChange={(e) => setParamValues((v) => ({ ...v, [p.key]: e.target.value }))} />
              )
            ))}
          </div>
          <button onClick={handleAdd} className="focus-ring mt-3 flex items-center gap-2 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white">
            <Plus size={14} /> Add to constitution
          </button>
        </div>

        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Current articles ({articles.length})</p>
          <div className="space-y-2">
            {articles.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary p-3 text-sm">
                <span className={a.enabled ? 'text-text-primary' : 'text-text-secondary line-through'}>{a.title}</span>
                <div className="flex gap-2">
                  <button onClick={() => toggleArticle(a.id, !a.enabled).then(load)} className="focus-ring rounded-lg bg-bg-tertiary px-3 py-1.5 text-xs font-medium text-text-secondary">
                    {a.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button onClick={() => deleteArticle(a.id).then(load)} className="focus-ring rounded-lg bg-error-500/15 p-1.5 text-error-500"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <div className="mb-3 flex items-center gap-2"><ShieldAlert size={16} className="text-warning-500" /><p className="text-sm font-semibold text-text-primary">Blocked actions</p></div>
          {violations.length === 0 ? (
            <p className="text-sm text-text-secondary">Nothing has been blocked yet.</p>
          ) : (
            <div className="space-y-2">
              {violations.map((v) => (
                <div key={v.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <span>{v.reason} <span className="text-xs text-text-secondary">({new Date(v.blocked_at).toLocaleString()})</span></span>
                  {!v.overridden ? (
                    <button onClick={() => handleOverride(v.id)} className="focus-ring rounded-lg bg-bg-tertiary px-3 py-1.5 text-xs font-medium text-text-secondary">Override</button>
                  ) : (
                    <span className="text-xs font-medium text-warning-500">Overridden</span>
                  )}
                </div>
              ))}
            </div>
          )}
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Agent authority matrix</p>
          <div className="space-y-2">
            {authorityMatrix.map((row) => (
              <div key={row.action_slug} className={`flex items-center justify-between rounded-xl border p-3 text-sm ${row.is_red_line ? 'border-error-500/40 bg-error-500/5' : 'border-border bg-bg-primary'}`}>
                <div>
                  <span className="font-medium text-text-primary">{row.label}</span>
                  <span className="ml-2 text-xs text-text-secondary">{row.agent_source} · {row.category}</span>
                  {row.is_red_line && <span className="ml-2 rounded-full bg-error-500/15 px-2 py-0.5 text-xs font-medium text-error-500">RED LINE</span>}
                </div>
                <span className="text-xs text-text-secondary">
                  {!row.enabled ? 'Disabled' : row.requires_approval ? 'Needs approval' : row.auto_approve_max_cents ? `Auto ≤ $${(row.auto_approve_max_cents / 100).toFixed(0)}` : 'Fully autonomous'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
        </div>
      </div>
    </DashboardLayout>
  );
}
