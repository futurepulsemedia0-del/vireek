/**
 * AI Security Center - /dashboard/security-center
 *
 * One place to govern how AI touches customer, financial, location, equipment, recording and contract
 * data: posture score, prompt-injection + PII policy, per-agent sandbox, security event triage, tenant
 * isolation audit and API-key hygiene. See src/lib/aiSecurity.ts and
 * supabase/functions/_shared/ai-core/aiSecurity.ts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Bot, CheckCircle2, Database, KeyRound, LockKeyhole, RefreshCw, ShieldAlert, SlidersHorizontal, XCircle } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  AI_PROVIDERS,
  DATA_DOMAINS,
  DEFAULT_SETTINGS,
  DOMAIN_LABELS,
  EVENT_LABELS,
  SEVERITY_ORDER,
  SEVERITY_STYLES,
  apiKeyHygiene,
  computePosture,
  deleteSandboxPolicy,
  errMessage,
  fetchActiveApiKeys,
  fetchEventCounts,
  fetchEvents,
  fetchIdentityBaseline,
  fetchKnownAgents,
  fetchSandboxPolicies,
  fetchSettings,
  runIsolationAudit,
  saveSandboxPolicy,
  saveSettings,
  setEventStatus,
  type AgentSandboxPolicy,
  type AiProvider,
  type AiSecuritySettings,
  type ApiKeySummary,
  type DataDomain,
  type EventCountRow,
  type EventStatus,
  type EventType,
  type IdentityBaseline,
  type IsolationRow,
  type PostureCheck,
  type SecurityEvent,
  type Severity,
} from '@/lib/aiSecurity';

type Tab = 'overview' | 'policies' | 'sandbox' | 'events' | 'isolation';

const TABS: { id: Tab; label: string; icon: typeof LockKeyhole }[] = [
  { id: 'overview', label: 'Overview', icon: LockKeyhole },
  { id: 'policies', label: 'Policies', icon: SlidersHorizontal },
  { id: 'sandbox', label: 'Agent sandbox', icon: Bot },
  { id: 'events', label: 'Events', icon: ShieldAlert },
  { id: 'isolation', label: 'Isolation & keys', icon: Database },
];

const IDENTITY_FALLBACK: IdentityBaseline = { sso_enforced: false, require_mfa_for_team: false, ip_restriction_enabled: false, session_idle_minutes: 0, session_max_hours: 0 };

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus-visible:border-accent disabled:opacity-50';

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function eventSummary(e: SecurityEvent): string {
  const d = e.detail ?? {};
  const parts: string[] = [];
  if (Array.isArray(d.rules) && d.rules.length) parts.push(`Rules: ${(d.rules as string[]).join(', ')}`);
  if (Array.isArray(d.reasons) && d.reasons.length) parts.push(`Reasons: ${(d.reasons as string[]).join(', ')}`);
  if (d.counts && typeof d.counts === 'object') {
    parts.push(Object.entries(d.counts as Record<string, number>).map(([k, n]) => `${k} x${n}`).join(', '));
  }
  if (typeof d.action === 'string') parts.push(`Action: ${d.action}`);
  if (typeof d.metric === 'string') parts.push(`${String(d.metric).replace(/_/g, ' ')}: ${String(d.last_hour)} in the last hour (typical ${String(d.baseline_avg)})`);
  if (typeof d.stage === 'string') parts.push(`Stage: ${d.stage}`);
  return parts.filter(Boolean).join(' - ');
}

function SeverityPill({ severity }: { severity: Severity }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${SEVERITY_STYLES[severity]}`}>{severity}</span>;
}

function StatusIcon({ status }: { status: PostureCheck['status'] }) {
  if (status === 'pass') return <CheckCircle2 size={16} className="shrink-0 text-success-500" />;
  if (status === 'warn') return <AlertTriangle size={16} className="shrink-0 text-warning-500" />;
  return <XCircle size={16} className="shrink-0 text-danger" />;
}

// ============================================================
// OVERVIEW
// ============================================================

function ScoreRing({ score }: { score: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const color = score >= 75 ? 'stroke-success-500' : score >= 55 ? 'stroke-warning-500' : 'stroke-danger';
  return (
    <svg viewBox="0 0 120 120" className="h-32 w-32 shrink-0" role="img" aria-label={`Security score ${score} out of 100`}>
      <circle cx="60" cy="60" r={r} fill="none" strokeWidth="10" className="stroke-bg-tertiary" />
      <circle
        cx="60"
        cy="60"
        r={r}
        fill="none"
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c - (c * score) / 100}
        transform="rotate(-90 60 60)"
        className={color}
      />
      <text x="60" y="66" textAnchor="middle" className="fill-text-primary text-[28px] font-semibold">
        {score}
      </text>
    </svg>
  );
}

function ActivityBars({ counts }: { counts: EventCountRow[] }) {
  const days = useMemo(() => {
    const out: { day: string; total: number; severe: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const rows = counts.filter((c) => c.day === day);
      out.push({
        day,
        total: rows.reduce((n, r) => n + r.total, 0),
        severe: rows.filter((r) => r.severity === 'high' || r.severity === 'critical').reduce((n, r) => n + r.total, 0),
      });
    }
    return out;
  }, [counts]);
  const max = Math.max(1, ...days.map((d) => d.total));
  return (
    <div className="flex h-24 items-end gap-1" role="img" aria-label="Security events per day, last 14 days">
      {days.map((d) => (
        <div key={d.day} className="flex flex-1 flex-col justify-end" title={`${d.day}: ${d.total} events (${d.severe} high/critical)`}>
          <div className={`w-full rounded-t ${d.severe > 0 ? 'bg-danger' : 'bg-accent/60'}`} style={{ height: `${Math.max(3, (d.total / max) * 100)}%` }} />
        </div>
      ))}
    </div>
  );
}

function OverviewTab({
  posture,
  counts,
  events,
  onNavigate,
}: {
  posture: ReturnType<typeof computePosture>;
  counts: EventCountRow[];
  events: SecurityEvent[];
  onNavigate: (t: Tab) => void;
}) {
  const open = events.filter((e) => e.status === 'open').sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)).slice(0, 5);
  const blocked = events.filter((e) => (e.detail as { action?: string }).action === 'blocked').length;
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-bg-secondary p-4 sm:flex-row sm:items-center">
        <ScoreRing score={posture.score} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">AI security posture</p>
          <p className="text-2xl font-semibold text-text-primary">{posture.label}</p>
          <p className="mt-1 text-sm text-text-secondary">
            Weighted across injection defense, data protection, agent sandboxing, identity, tenant isolation and open incidents.
          </p>
          <p className="mt-2 text-xs text-text-secondary">{blocked} request(s) blocked in the recent window.</p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <p className="mb-3 text-sm font-semibold text-text-primary">Events - last 14 days</p>
        <ActivityBars counts={counts} />
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <p className="mb-2 text-sm font-semibold text-text-primary">Hardening checklist</p>
        <ul className="divide-y divide-border">
          {posture.checks.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onNavigate(c.tab)} className="focus-ring flex w-full items-start gap-3 rounded-lg py-3 text-left hover:bg-bg-tertiary/50">
                <StatusIcon status={c.status} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-text-primary">{c.title}</span>
                  <span className="block text-xs text-text-secondary">{c.detail}</span>
                </span>
                <span className="text-[11px] text-text-secondary">{Math.round(c.earned * c.weight)}/{c.weight}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {open.length > 0 && (
        <div className="rounded-2xl border border-border bg-bg-secondary p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-text-primary">Needs review</p>
            <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={() => onNavigate('events')}>
              View all
            </button>
          </div>
          <ul className="space-y-2">
            {open.map((e) => (
              <li key={e.id} className="flex items-center gap-2 text-sm">
                <SeverityPill severity={e.severity} />
                <span className="text-text-primary">{EVENT_LABELS[e.event_type]}</span>
                <span className="truncate text-xs text-text-secondary">{e.agent_source ?? e.task ?? e.source}</span>
                <span className="ml-auto shrink-0 text-xs text-text-secondary">{timeAgo(e.created_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ============================================================
// POLICIES
// ============================================================

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-text-primary">{label}</p>
      {children}
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function PoliciesTab({ settings, identity, onSaved }: { settings: AiSecuritySettings; identity: IdentityBaseline; onSaved: () => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<AiSecuritySettings>(settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(settings), [settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const set = <K extends keyof AiSecuritySettings>(k: K, v: AiSecuritySettings[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const toggleProvider = (p: AiProvider) => {
    const cur = draft.allowed_providers ?? [];
    const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p];
    set('allowed_providers', next.length ? next : null);
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveSettings(draft);
      toast('AI security policy saved');
      onSaved();
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 rounded-2xl border border-border bg-bg-secondary p-4 sm:grid-cols-2">
        <Field label="Prompt-injection defense" hint="Block stops high-risk prompts. Sanitize isolates them as untrusted data. Monitor only logs.">
          <select className={selectClass} value={draft.injection_mode} onChange={(e) => set('injection_mode', e.target.value as AiSecuritySettings['injection_mode'])}>
            <option value="block">Block high-risk prompts</option>
            <option value="sanitize">Sanitize (isolate as untrusted)</option>
            <option value="monitor">Monitor only</option>
          </select>
        </Field>
        <Input
          label="Block threshold (20-100)"
          type="number"
          min={20}
          max={100}
          value={draft.injection_block_score}
          disabled={draft.injection_mode !== 'block'}
          helperText="Risk score at or above which a prompt is blocked."
          onChange={(e) => set('injection_block_score', Math.min(100, Math.max(20, Number(e.target.value) || 70)))}
        />
        <Field label="PII & secret protection" hint="Sensitive: cards, SSN, IBAN, API secrets are redacted. Full also tokenizes emails and phones and restores them in the reply.">
          <select className={selectClass} value={draft.pii_mode} onChange={(e) => set('pii_mode', e.target.value as AiSecuritySettings['pii_mode'])}>
            <option value="full">Full (redact + tokenize contact data)</option>
            <option value="sensitive">Sensitive data only</option>
            <option value="off">Off</option>
          </select>
        </Field>
        <Field label="Agent sandbox" hint="Audit logs violations. Enforce blocks the AI call. Start in Audit, review the Events tab, then enforce.">
          <select className={selectClass} value={draft.sandbox_mode} onChange={(e) => set('sandbox_mode', e.target.value as AiSecuritySettings['sandbox_mode'])}>
            <option value="enforce">Enforce</option>
            <option value="audit">Audit only</option>
            <option value="off">Off</option>
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Allowed AI providers" hint="Leave all unchecked to allow any configured provider. If you select some, requests only route to those.">
            <div className="flex flex-wrap gap-2">
              {AI_PROVIDERS.map((p) => {
                const on = draft.allowed_providers?.includes(p) ?? false;
                return (
                  <label key={p} className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm capitalize ${on ? 'border-accent bg-accent/10 text-text-primary' : 'border-border text-text-secondary'}`}>
                    <input type="checkbox" checked={on} onChange={() => toggleProvider(p)} className="accent-[rgb(var(--accent))]" />
                    {p}
                  </label>
                );
              })}
            </div>
          </Field>
        </div>
        <Input
          label="API key max age (days)"
          type="number"
          min={7}
          max={730}
          value={draft.api_key_max_age_days}
          helperText="Keys older than this are flagged for rotation."
          onChange={(e) => set('api_key_max_age_days', Math.min(730, Math.max(7, Number(e.target.value) || 90)))}
        />
        <label className="flex cursor-pointer items-start gap-3 self-end rounded-xl border border-border p-3">
          <input type="checkbox" className="mt-0.5 accent-[rgb(var(--accent))]" checked={draft.anomaly_alerts_enabled} onChange={(e) => set('anomaly_alerts_enabled', e.target.checked)} />
          <span>
            <span className="block text-sm font-medium text-text-primary">Anomaly alerts</span>
            <span className="block text-xs text-text-secondary">Notify me when security events spike far above the 7-day baseline.</span>
          </span>
        </label>
      </div>

      <div className="flex items-center justify-between gap-3">
        <Button onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving...' : 'Save policy'}
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft(settings)}>
            Discard changes
          </Button>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <p className="text-sm font-semibold text-text-primary">Identity & session controls</p>
        <p className="mt-1 text-xs text-text-secondary">
          MFA {identity.require_mfa_for_team ? 'required' : 'not required'} - SSO {identity.sso_enforced ? 'enforced' : 'not enforced'} - IP restriction {identity.ip_restriction_enabled ? 'on' : 'off'} - idle timeout{' '}
          {identity.session_idle_minutes ? `${identity.session_idle_minutes} min` : 'off'}
        </p>
        <Link to="/dashboard/settings/enterprise-security" className="mt-2 inline-block text-xs font-medium text-accent hover:underline">
          Manage in Enterprise Security
        </Link>
      </div>
    </div>
  );
}

// ============================================================
// AGENT SANDBOX
// ============================================================

function AgentRow({ agent, policy, sandboxMode, onSaved }: { agent: string; policy: AgentSandboxPolicy | undefined; sandboxMode: AiSecuritySettings['sandbox_mode']; onSaved: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const initial = useMemo(
    () => ({
      agent_source: agent,
      enabled: policy?.enabled ?? true,
      allowed_domains: policy?.allowed_domains ?? (['customers', 'equipment', 'business_decisions'] as DataDomain[]),
      max_records_per_run: policy?.max_records_per_run ?? null,
      allow_external_send: policy?.allow_external_send ?? false,
      allow_write: policy?.allow_write ?? false,
    }),
    [agent, policy],
  );
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);

  const toggleDomain = (d: DataDomain) =>
    setDraft((x) => ({ ...x, allowed_domains: x.allowed_domains.includes(d) ? x.allowed_domains.filter((y) => y !== d) : [...x.allowed_domains, d] }));

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      setOpen(false);
      onSaved();
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-2xl border border-border bg-bg-secondary">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="focus-ring flex w-full items-center gap-3 rounded-2xl p-3 text-left">
        <Bot size={16} className="shrink-0 text-text-secondary" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text-primary">{agent}</span>
          <span className="block text-xs text-text-secondary">
            {policy
              ? `${policy.enabled ? 'Active' : 'Disabled'} - ${policy.allowed_domains.length} data domain(s)${policy.allow_external_send ? ' - external send' : ''}${policy.allow_write ? ' - writes' : ''}`
              : 'No explicit policy - built-in least-privilege defaults'}
          </span>
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${policy ? 'bg-success-500/15 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}>{policy ? 'Configured' : 'Default'}</span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-border p-4">
          {sandboxMode === 'off' && <p className="text-xs text-warning-500">The sandbox is currently Off, so these rules are not evaluated until you turn it on in Policies.</p>}
          <div>
            <p className="mb-2 text-sm font-medium text-text-primary">Data this agent may place in a prompt</p>
            <div className="flex flex-wrap gap-2">
              {DATA_DOMAINS.map((d) => {
                const on = draft.allowed_domains.includes(d);
                return (
                  <label key={d} className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-1.5 text-xs ${on ? 'border-accent bg-accent/10 text-text-primary' : 'border-border text-text-secondary'}`}>
                    <input type="checkbox" checked={on} onChange={() => toggleDomain(d)} className="accent-[rgb(var(--accent))]" />
                    {DOMAIN_LABELS[d]}
                  </label>
                );
              })}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft((x) => ({ ...x, enabled: e.target.checked }))} className="accent-[rgb(var(--accent))]" /> Agent enabled
            </label>
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" checked={draft.allow_external_send} onChange={(e) => setDraft((x) => ({ ...x, allow_external_send: e.target.checked }))} className="accent-[rgb(var(--accent))]" /> May send externally
            </label>
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" checked={draft.allow_write} onChange={(e) => setDraft((x) => ({ ...x, allow_write: e.target.checked }))} className="accent-[rgb(var(--accent))]" /> May write data
            </label>
          </div>
          <Input
            label="Max records per run (optional)"
            type="number"
            min={1}
            value={draft.max_records_per_run ?? ''}
            onChange={(e) => setDraft((x) => ({ ...x, max_records_per_run: e.target.value ? Math.max(1, Number(e.target.value)) : null }))}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => run(() => saveSandboxPolicy(draft), 'Sandbox policy saved')}>
              Save policy
            </Button>
            {policy && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => deleteSandboxPolicy(agent), 'Reverted to defaults')}>
                Revert to defaults
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function SandboxTab({ agents, policies, settings, onSaved }: { agents: string[]; policies: AgentSandboxPolicy[]; settings: AiSecuritySettings; onSaved: () => void }) {
  const byAgent = useMemo(() => new Map(policies.map((p) => [p.agent_source, p])), [policies]);
  const all = useMemo(() => [...new Set([...agents, ...policies.map((p) => p.agent_source)])].sort(), [agents, policies]);
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">
        Mode: <span className="font-semibold capitalize text-text-primary">{settings.sandbox_mode}</span>. An agent that declares data it is about to send to a model is checked against its policy. Agents without a policy fall back to customer, equipment and business-decision data only, with no external send or writes.
      </p>
      <ul className="space-y-2">
        {all.map((a) => (
          <AgentRow key={a} agent={a} policy={byAgent.get(a)} sandboxMode={settings.sandbox_mode} onSaved={onSaved} />
        ))}
      </ul>
    </div>
  );
}

// ============================================================
// EVENTS
// ============================================================

function EventsTab({ events, onChanged }: { events: SecurityEvent[]; onChanged: () => void }) {
  const { toast } = useToast();
  const [view, setView] = useState<'open' | 'all'>('open');
  const [type, setType] = useState<EventType | 'all'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows = useMemo(
    () => events.filter((e) => (view === 'all' || e.status === 'open') && (type === 'all' || e.event_type === type)),
    [events, view, type],
  );

  const act = async (id: string, status: 'acknowledged' | 'resolved' | 'false_positive') => {
    setBusyId(id);
    try {
      await setEventStatus(id, status);
      onChanged();
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select className={`${selectClass} !w-auto`} value={view} onChange={(e) => setView(e.target.value as 'open' | 'all')} aria-label="Status filter">
          <option value="open">Needs review</option>
          <option value="all">All events</option>
        </select>
        <select className={`${selectClass} !w-auto`} value={type} onChange={(e) => setType(e.target.value as EventType | 'all')} aria-label="Type filter">
          <option value="all">All types</option>
          {(Object.keys(EVENT_LABELS) as EventType[]).filter((t) => t !== 'policy_change').map((t) => (
            <option key={t} value={t}>
              {EVENT_LABELS[t]}
            </option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={ShieldAlert} title="Nothing to review" description="Prompt-injection attempts, PII protections, sandbox violations and anomalies will appear here as they happen." />
      ) : (
        <ul className="space-y-2">
          {rows.map((e) => (
            <li key={e.id} className="rounded-2xl border border-border bg-bg-secondary p-3">
              <div className="flex flex-wrap items-center gap-2">
                <SeverityPill severity={e.severity} />
                <span className="text-sm font-medium text-text-primary">{EVENT_LABELS[e.event_type]}</span>
                {e.risk_score !== null && <span className="text-xs text-text-secondary">risk {e.risk_score}</span>}
                <span className="ml-auto text-xs text-text-secondary">{timeAgo(e.created_at)}</span>
              </div>
              <p className="mt-1 text-xs text-text-secondary">
                {[e.agent_source, e.task].filter(Boolean).join(' - ') || e.source}
                {eventSummary(e) ? ` - ${eventSummary(e)}` : ''}
              </p>
              {e.status === 'open' ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" disabled={busyId === e.id} onClick={() => act(e.id, 'acknowledged')}>
                    Acknowledge
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busyId === e.id} onClick={() => act(e.id, 'resolved')}>
                    Resolve
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busyId === e.id} onClick={() => act(e.id, 'false_positive')}>
                    False positive
                  </Button>
                </div>
              ) : (
                <p className="mt-1 text-[11px] capitalize text-text-secondary">{(e.status as EventStatus).replace('_', ' ')}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ============================================================
// ISOLATION & KEYS
// ============================================================

function IsolationTab({
  isolation,
  onRun,
  running,
  keys,
  maxAgeDays,
}: {
  isolation: IsolationRow[] | null;
  onRun: () => void;
  running: boolean;
  keys: ApiKeySummary[];
  maxAgeDays: number;
}) {
  const issues = useMemo(() => apiKeyHygiene(keys, maxAgeDays), [keys, maxAgeDays]);
  const flagged = isolation?.filter((r) => r.risk !== 'ok') ?? [];
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-text-primary">Tenant isolation audit</p>
            <p className="mt-1 text-xs text-text-secondary">
              Inspects every table that holds tenant data and verifies row-level security is on with no wide-open policy. Returns schema metadata only, never your data.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={onRun} disabled={running}>
            <RefreshCw size={14} className={running ? 'animate-spin' : ''} /> {isolation ? 'Re-run' : 'Run audit'}
          </Button>
        </div>
        {isolation && (
          <div className="mt-3">
            <p className="flex items-center gap-2 text-sm text-text-primary">
              {flagged.length === 0 ? <CheckCircle2 size={16} className="text-success-500" /> : <AlertTriangle size={16} className="text-danger" />}
              {flagged.length === 0 ? `All ${isolation.length} tenant tables are isolated.` : `${flagged.length} of ${isolation.length} tenant tables need attention.`}
            </p>
            {flagged.length > 0 && (
              <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
                {flagged.map((r) => (
                  <li key={r.table_name} className="flex items-center gap-2 p-2 text-sm">
                    <SeverityPill severity={r.risk === 'critical' ? 'critical' : 'high'} />
                    <code className="text-xs text-text-primary">{r.table_name}</code>
                    <span className="ml-auto text-xs text-text-secondary">{r.rls_enabled ? `${r.open_policy_count} open policy` : 'RLS disabled'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <KeyRound size={15} /> API key hygiene
          </p>
          <Link to="/dashboard/settings/api-keys" className="text-xs font-medium text-accent hover:underline">
            Manage keys
          </Link>
        </div>
        {keys.length === 0 ? (
          <p className="mt-2 text-xs text-text-secondary">No active API keys.</p>
        ) : issues.length === 0 ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-text-primary">
            <CheckCircle2 size={16} className="text-success-500" /> All {keys.length} active key(s) are within policy.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
            {issues.map((i) => (
              <li key={i.id} className="flex items-center gap-2 p-2 text-sm">
                <span className="font-medium text-text-primary">{i.name}</span>
                <code className="text-xs text-text-secondary">{i.key_prefix}</code>
                <span className="ml-auto text-xs text-warning-500">{i.issue === 'rotation_due' ? `Rotate - ${i.ageDays}d old` : 'Unused - consider revoking'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function AiSecurityCenterPage() {
  const { permissions } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [settings, setSettings] = useState<AiSecuritySettings>(DEFAULT_SETTINGS);
  const [policies, setPolicies] = useState<AgentSandboxPolicy[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [counts, setCounts] = useState<EventCountRow[]>([]);
  const [identity, setIdentity] = useState<IdentityBaseline>(IDENTITY_FALLBACK);
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [isolation, setIsolation] = useState<IsolationRow[] | null>(null);
  const [auditing, setAuditing] = useState(false);
  const allowed = permissions.can_manage_security;

  const load = useCallback(async () => {
    try {
      const [s, p, a, e, c, i, k] = await Promise.all([
        fetchSettings(),
        fetchSandboxPolicies(),
        fetchKnownAgents(),
        fetchEvents(),
        fetchEventCounts(14),
        fetchIdentityBaseline(),
        fetchActiveApiKeys(),
      ]);
      setSettings(s);
      setPolicies(p);
      setAgents(a);
      setEvents(e);
      setCounts(c);
      setIdentity(i);
      setKeys(k);
    } catch (err) {
      toast(errMessage(err), 'error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    if (allowed) void load();
    else setLoading(false);
  }, [allowed, load]);

  const refresh = () => {
    setRefreshing(true);
    void load();
  };

  const audit = async () => {
    setAuditing(true);
    try {
      setIsolation(await runIsolationAudit());
    } catch (err) {
      toast(errMessage(err), 'error');
    } finally {
      setAuditing(false);
    }
  };

  const keyIssues = useMemo(() => apiKeyHygiene(keys, settings.api_key_max_age_days), [keys, settings.api_key_max_age_days]);
  const posture = useMemo(
    () => computePosture({ settings, sandboxPolicies: policies, knownAgents: agents, identity, isolation, keyIssues, openEvents: events }),
    [settings, policies, agents, identity, isolation, keyIssues, events],
  );
  const openCount = events.filter((e) => e.status === 'open').length;

  return (
    <DashboardLayout activeLabel="AI Security Center">
      <div className="mx-auto max-w-4xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <LockKeyhole size={18} /> AI Security Center
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Control how AI agents access customer, financial, location, equipment, recording and contract data - with sandboxing, PII protection, prompt-injection defense, isolation checks and a full audit trail.
            </p>
          </div>
          {allowed && (
            <Button size="sm" variant="secondary" onClick={refresh} disabled={refreshing || loading}>
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </Button>
          )}
        </div>

        {!allowed ? (
          <EmptyState icon={LockKeyhole} title="Security permission required" description="Ask an account owner to grant you the security management permission." />
        ) : loading ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} />
          </div>
        ) : (
          <>
            <div role="tablist" aria-label="AI security sections" className="mb-4 flex gap-1 overflow-x-auto rounded-2xl border border-border bg-bg-secondary p-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  type="button"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`focus-ring flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${tab === t.id ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'}`}
                >
                  <t.icon size={14} /> {t.label}
                  {t.id === 'events' && openCount > 0 && <span className="rounded-full bg-danger px-1.5 text-[10px] font-semibold text-white">{openCount}</span>}
                </button>
              ))}
            </div>

            {tab === 'overview' && <OverviewTab posture={posture} counts={counts} events={events} onNavigate={setTab} />}
            {tab === 'policies' && <PoliciesTab settings={settings} identity={identity} onSaved={refresh} />}
            {tab === 'sandbox' && <SandboxTab agents={agents} policies={policies} settings={settings} onSaved={refresh} />}
            {tab === 'events' && <EventsTab events={events} onChanged={refresh} />}
            {tab === 'isolation' && <IsolationTab isolation={isolation} onRun={audit} running={auditing} keys={keys} maxAgeDays={settings.api_key_max_age_days} />}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
