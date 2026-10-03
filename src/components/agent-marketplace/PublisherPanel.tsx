import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2, Plus, ShieldAlert } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import {
  CATEGORY_LABELS,
  MANIFEST_TEMPLATE,
  dollarsToCents,
  fetchMyPublishedAgents,
  fetchReviewQueue,
  fetchVersionsForAgents,
  formatPrice,
  parseManifestInput,
  registerAgent,
  reviewVersion,
  submitAgentVersion,
  type AgentCategory,
  type MarketplaceAgent,
  type MarketplaceVersion,
  type PricingModel,
  type ReviewQueueItem,
} from '@/lib/agentMarketplace';

const field = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  in_review: 'bg-warning-500/10 text-warning-500',
  published: 'bg-success-500/10 text-success-500',
  suspended: 'bg-danger/10 text-danger',
  submitted: 'bg-warning-500/10 text-warning-500',
  approved: 'bg-success-500/10 text-success-500',
  rejected: 'bg-danger/10 text-danger',
  deprecated: 'bg-bg-tertiary text-text-secondary',
};

export function PublisherPanel({ userId }: { userId: string }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<MarketplaceAgent[]>([]);
  const [versions, setVersions] = useState<MarketplaceVersion[]>([]);
  const [queue, setQueue] = useState<ReviewQueueItem[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [form, setForm] = useState({
    slug: '', publisherName: '', name: '', tagline: '', description: '', category: 'general' as AgentCategory,
    endpointUrl: '', pricingModel: 'free' as PricingModel, price: '0',
  });
  const [versionAgent, setVersionAgent] = useState<string | null>(null);
  const [versionText, setVersionText] = useState('1.0.0');
  const [manifestText, setManifestText] = useState(MANIFEST_TEMPLATE);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const mine = await fetchMyPublishedAgents(userId);
      setAgents(mine);
      setVersions(await fetchVersionsForAgents(mine.map((a) => a.id)));
    } catch {
      toast('Could not load your agents.', 'error');
    }
    // Staff-only: the RPC rejects everyone else, which simply hides the section.
    try {
      setQueue(await fetchReviewQueue());
    } catch {
      setQueue(null);
    }
    setLoading(false);
  }, [userId, toast]);

  useEffect(() => { void load(); }, [load]);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const handleRegister = async () => {
    const priceCents = form.pricingModel === 'free' ? 0 : dollarsToCents(form.price);
    if (priceCents === null || (form.pricingModel !== 'free' && priceCents === 0)) return toast('Enter a valid price in dollars.', 'error');
    if (!/^https:\/\//i.test(form.endpointUrl.trim())) return toast('The endpoint must be an https:// URL.', 'error');
    setBusy(true);
    try {
      const res = await registerAgent({
        slug: form.slug.trim().toLowerCase(), publisherName: form.publisherName.trim(), name: form.name.trim(),
        tagline: form.tagline.trim(), description: form.description.trim(), category: form.category,
        endpointUrl: form.endpointUrl.trim(), pricingModel: form.pricingModel, priceCents,
      });
      setSecret(res.signing_secret);
      setShowForm(false);
      toast('Agent registered. Copy your signing secret now — it is shown only once.', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not register the agent.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitVersion = async () => {
    if (!versionAgent) return;
    const parsed = parseManifestInput(manifestText);
    if (!parsed.ok) return toast(parsed.error, 'error');
    if (!/^\d+\.\d+\.\d+$/.test(versionText.trim())) return toast('Version must look like 1.0.0.', 'error');
    setBusy(true);
    try {
      await submitAgentVersion(versionAgent, versionText.trim(), parsed.manifest);
      toast('Version submitted for review.', 'success');
      setVersionAgent(null);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not submit this version.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleReview = async (item: ReviewQueueItem, approve: boolean) => {
    const note = (notes[item.version_id] ?? '').trim();
    if (!approve && !note) return toast('Add a short note explaining the rejection.', 'error');
    setBusy(true);
    try {
      await reviewVersion(item.version_id, approve, note || null);
      toast(approve ? 'Version approved and published.' : 'Version rejected.', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Review failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const copySecret = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Could not copy. Select the text and copy it manually.', 'error');
    }
  };

  if (loading) return <div className="flex h-32 items-center justify-center"><Loader2 className="animate-spin" /></div>;

  return (
    <div className="space-y-6">
      {secret && (
        <div className="rounded-2xl border border-warning-500/40 bg-warning-500/5 p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary"><ShieldAlert size={16} className="text-warning-500" /> Your signing secret (shown once)</p>
          <p className="mb-3 text-xs text-text-secondary">
            Verify every request: HMAC-SHA256 of <code>{'`${X-Vireek-Timestamp}.${rawBody}`'}</code> with this secret must equal the value after <code>v1=</code> in <code>X-Vireek-Signature</code>. Reject timestamps older than 5 minutes.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-bg-primary px-3 py-2 text-xs text-text-primary">{secret}</code>
            <button onClick={copySecret} className="focus-ring flex items-center gap-1.5 rounded-xl bg-cta px-3 py-2 text-xs font-medium text-white">
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={() => setSecret(null)} className="focus-ring rounded-xl bg-bg-tertiary px-3 py-2 text-xs font-medium text-text-secondary">I saved it</button>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-border bg-bg-secondary p-5">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold text-text-primary">Your agents</p>
          <button onClick={() => setShowForm((s) => !s)} className="focus-ring flex items-center gap-1.5 rounded-xl bg-cta px-3 py-1.5 text-xs font-medium text-white">
            <Plus size={12} /> {showForm ? 'Close' : 'Register an agent'}
          </button>
        </div>

        {showForm && (
          <div className="mb-4 grid gap-2 rounded-xl border border-border bg-bg-primary p-4 sm:grid-cols-2">
            <input className={field} placeholder="Slug (e.g. acme-hvac-pro)" value={form.slug} onChange={(e) => set('slug', e.target.value)} />
            <input className={field} placeholder="Publisher name" value={form.publisherName} onChange={(e) => set('publisherName', e.target.value)} />
            <input className={field} placeholder="Agent name" value={form.name} onChange={(e) => set('name', e.target.value)} />
            <select className={field} value={form.category} onChange={(e) => set('category', e.target.value as AgentCategory)}>
              {(Object.keys(CATEGORY_LABELS) as AgentCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select>
            <input className={`${field} sm:col-span-2`} placeholder="Tagline (max 160 chars)" maxLength={160} value={form.tagline} onChange={(e) => set('tagline', e.target.value)} />
            <textarea className={`${field} sm:col-span-2`} rows={3} maxLength={2000} placeholder="Description" value={form.description} onChange={(e) => set('description', e.target.value)} />
            <input className={`${field} sm:col-span-2`} placeholder="Webhook endpoint (https://…, public domain, port 443)" value={form.endpointUrl} onChange={(e) => set('endpointUrl', e.target.value)} />
            <select className={field} value={form.pricingModel} onChange={(e) => set('pricingModel', e.target.value as PricingModel)}>
              <option value="free">Free</option><option value="per_run">Per run</option><option value="monthly">Monthly subscription</option>
            </select>
            <input className={field} disabled={form.pricingModel === 'free'} inputMode="decimal" placeholder="Price in USD" value={form.price} onChange={(e) => set('price', e.target.value)} />
            <button disabled={busy} onClick={handleRegister} className="focus-ring flex w-fit items-center gap-2 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-50 sm:col-span-2">
              {busy && <Loader2 size={14} className="animate-spin" />} Register
            </button>
          </div>
        )}

        {agents.length === 0 ? (
          <p className="text-sm text-text-secondary">You haven’t registered an agent yet. Vireek keeps a platform fee on paid agents; free agents pay none.</p>
        ) : (
          <div className="space-y-3">
            {agents.map((a) => {
              const vs = versions.filter((v) => v.agent_id === a.id);
              return (
                <div key={a.id} className="rounded-xl border border-border bg-bg-primary p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-text-primary">{a.name} <span className="text-xs font-normal text-text-secondary">· {a.slug} · {formatPrice(a)}</span></p>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[a.status]}`}>{a.status.replace('_', ' ')}</span>
                      {a.status !== 'suspended' && (
                        <button onClick={() => { setVersionAgent(a.id); setVersionText('1.0.0'); }} className="focus-ring rounded-lg bg-bg-tertiary px-2.5 py-1.5 text-xs font-medium text-text-secondary">Submit version</button>
                      )}
                    </div>
                  </div>
                  {a.suspended_reason && <p className="mt-2 text-xs text-danger">{a.suspended_reason}</p>}
                  {vs.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {vs.map((v) => (
                        <span key={v.id} title={v.review_notes ?? undefined} className={`rounded-full px-2.5 py-0.5 text-xs ${STATUS_STYLES[v.status]}`}>v{v.version} · {v.status}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {versionAgent && (
          <div className="mt-4 space-y-2 rounded-xl border border-border bg-bg-primary p-4">
            <input className={field} placeholder="Version (e.g. 1.0.0)" value={versionText} onChange={(e) => setVersionText(e.target.value)} />
            <textarea className={`${field} font-mono text-xs`} rows={9} spellCheck={false} value={manifestText} onChange={(e) => setManifestText(e.target.value)} aria-label="Manifest JSON" />
            <p className="text-[11px] text-text-secondary">Scopes: read:jobs, read:job_financials, read:customers, read:customer_contact, act:record_insight, act:create_task, act:send_sms. Triggers: manual, schedule.daily, job.scheduled, job.completed.</p>
            <div className="flex gap-2">
              <button disabled={busy} onClick={handleSubmitVersion} className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {busy && <Loader2 size={14} className="animate-spin" />} Submit for review
              </button>
              <button onClick={() => setVersionAgent(null)} className="focus-ring rounded-xl bg-bg-tertiary px-4 py-2 text-sm font-medium text-text-secondary">Cancel</button>
            </div>
          </div>
        )}
      </div>

      {queue !== null && (
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Review queue (Vireek staff)</p>
          {queue.length === 0 ? (
            <p className="text-sm text-text-secondary">Nothing waiting for review.</p>
          ) : (
            <div className="space-y-3">
              {queue.map((q) => (
                <div key={q.version_id} className="rounded-xl border border-border bg-bg-primary p-4">
                  <p className="text-sm font-medium text-text-primary">{q.agent_name} v{q.version} <span className="text-xs font-normal text-text-secondary">· {q.publisher_name}</span></p>
                  <p className="truncate text-xs text-text-secondary">{q.endpoint_url}</p>
                  <pre className="my-2 max-h-40 overflow-auto rounded-lg bg-bg-secondary p-2 text-[11px] text-text-primary">{JSON.stringify(q.manifest, null, 2)}</pre>
                  <input className={`${field} mb-2`} placeholder="Review note (required to reject)" value={notes[q.version_id] ?? ''} onChange={(e) => setNotes((n) => ({ ...n, [q.version_id]: e.target.value }))} />
                  <div className="flex gap-2">
                    <button disabled={busy} onClick={() => handleReview(q, true)} className="focus-ring rounded-xl bg-success-500 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Approve & publish</button>
                    <button disabled={busy} onClick={() => handleReview(q, false)} className="focus-ring rounded-xl bg-danger px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Reject</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
