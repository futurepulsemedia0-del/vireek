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
  fetchViolations,
  overrideViolation,
  toggleArticle,
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
  const [paramValue, setParamValue] = useState('');

  const template = RULE_TEMPLATES.find((t) => t.rule_type === selectedTemplate);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, v] = await Promise.all([fetchArticles(), fetchViolations()]);
      setArticles(a); setViolations(v);
    } catch {
      toast('Could not load the constitution.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const handleAdd = async () => {
    try {
      const params = template?.paramKey ? { [template.paramKey]: Number(paramValue || template.defaultValue) } : {};
      await createArticle(selectedTemplate, params);
      setParamValue(''); toast('Article added to the constitution.', 'success'); void load();
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
              value={selectedTemplate} onChange={(e) => setSelectedTemplate(e.target.value as RuleType)}>
              {RULE_TEMPLATES.map((t) => <option key={t.rule_type} value={t.rule_type}>{t.label}</option>)}
            </select>
            {template?.paramKey && (
              <input className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                type="number" placeholder={template.paramLabel} value={paramValue} onChange={(e) => setParamValue(e.target.value)} />
            )}
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
        </div>
      </div>
    </DashboardLayout>
  );
}
