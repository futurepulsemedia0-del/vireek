import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import {
  addIdentityRef, eraseIdentity, fetchRelationshipRegistry, grantIdentityAccess, linkIdentities, mergeIdentities,
  resolveIdentityUid, revokeIdentityGrant, transitionIdentity, unlinkIdentities, updateIdentity, verifyIdentityChain,
} from '@/lib/universalIdentityApi';
import {
  ASSURANCE_LABELS, ENTITY_TYPE_META, EVENT_LABELS, LIFECYCLE_META, SOURCE_LABELS, allowedTransitions, confidenceLabel,
  formatConfidence, identityErrorMessage, isTerminal, looksLikeUid, parseAttributesInput, relativeTime, shortUid, transitionNeedsReason,
  type ChainStatus, type EntityType, type IdentityDossier, type LifecycleState,
} from '@/lib/universalIdentity';

const FIELD = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/70';
const TABS = ['overview', 'relationships', 'provenance', 'history', 'access'] as const;
type Tab = (typeof TABS)[number];
type Registry = Awaited<ReturnType<typeof fetchRelationshipRegistry>>;

const TONE: Record<string, string> = {
  ok: 'bg-success-500/10 text-success-500', warn: 'bg-amber-500/10 text-amber-500', bad: 'bg-danger/10 text-danger', muted: 'bg-bg-tertiary text-text-secondary',
};

export function EntityDossier({
  dossier,
  onChanged,
  onSelect,
}: {
  dossier: IdentityDossier;
  onChanged: () => void;
  onSelect: (id: string) => void;
}) {
  const { toast } = useToast();
  const e = dossier.entity;
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);
  const [chain, setChain] = useState<ChainStatus | null>(null);
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [confirm, setConfirm] = useState<'erase' | null>(null);

  // overview forms
  const [editName, setEditName] = useState('');
  const [editAttrs, setEditAttrs] = useState('');
  const [reason, setReason] = useState('');
  const [refForm, setRefForm] = useState({ system: '', type: '', value: '' });
  // relationships
  const [linkUid, setLinkUid] = useState('');
  const [linkRel, setLinkRel] = useState('');
  const [linkOptions, setLinkOptions] = useState<{ targetId: string; rels: Registry } | null>(null);
  // danger
  const [mergeUid, setMergeUid] = useState('');
  // access
  const [grant, setGrant] = useState({ kind: 'tenant' as 'tenant' | 'agent', id: '', purpose: '', days: 30, actions: ['read'] as string[] });

  const entityId = e?.id ?? '';
  useEffect(() => {
    setTab('overview'); setChain(null); setLinkOptions(null); setLinkUid(''); setReason('');
    if (e) { setEditName(e.display_name); setEditAttrs(e.attributes_redacted ? '' : JSON.stringify(e.attributes, null, 2)); }
    // reset only when the selected entity (or its version) changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, e?.version]);

  const run = useCallback(async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok, 'success'); onChanged(); }
    catch (err) { toast(identityErrorMessage(err), 'error'); }
    finally { setBusy(false); }
  }, [onChanged, toast]);

  if (!e) return null;
  const meta = ENTITY_TYPE_META[e.entity_type];
  const state = LIFECYCLE_META[e.lifecycle_state];
  const terminal = isTerminal(e.lifecycle_state) || e.lifecycle_state === 'erased';
  const p = dossier.permissions;
  const next = allowedTransitions(e.lifecycle_state);
  const needsReason = next.some(transitionNeedsReason);

  async function verify() {
    try { setChain(await verifyIdentityChain(e!.id)); } catch (err) { toast(identityErrorMessage(err), 'error'); }
  }

  async function prepareLink() {
    if (!looksLikeUid(linkUid)) return toast('Paste the target\'s universal ID (VRK-…).', 'error');
    setBusy(true);
    try {
      const target = await resolveIdentityUid(linkUid);
      if (!target.found || !target.entity) return toast('No entity found for that ID.', 'error');
      const reg = registry ?? (await fetchRelationshipRegistry());
      setRegistry(reg);
      const rels = reg.filter((r) => r.src_type === e!.entity_type && r.dst_type === target.entity!.entity_type);
      if (rels.length === 0) return toast(`A ${meta.label.toLowerCase()} cannot be linked to a ${ENTITY_TYPE_META[target.entity.entity_type].label.toLowerCase()}. Try linking from the other side.`, 'error');
      setLinkOptions({ targetId: target.entity.id, rels }); setLinkRel(rels[0].rel_type);
    } catch (err) { toast(identityErrorMessage(err), 'error'); }
    finally { setBusy(false); }
  }

  const tabLabel = (t: Tab) => ({ overview: 'Overview', relationships: `Relationships (${dossier.relationships.filter((r) => r.status === 'active').length})`, provenance: 'Provenance', history: 'History', access: 'Access' })[t];
  const typeOf = (t: EntityType | null) => (t ? ENTITY_TYPE_META[t].label : 'Entity');

  return (
    <section aria-label="Identity details" className="rounded-2xl border border-border bg-bg-secondary p-4">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: meta.color }}>{meta.label}{e.scope === 'global' && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-text-secondary">Global</span>}</p>
          <h2 className="truncate text-lg font-bold text-text-primary">{e.display_name}</h2>
          <button type="button" className="focus-ring break-all rounded text-left font-mono text-xs text-text-secondary hover:text-accent" title="Copy universal ID"
            onClick={() => { void navigator.clipboard?.writeText(e.uid).then(() => toast('Universal ID copied', 'success')).catch(() => undefined); }}>{e.uid}</button>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <span className={`rounded-full px-2 py-0.5 font-medium ${TONE[state.tone]}`}>{state.label}</span>
          <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-text-secondary">{ASSURANCE_LABELS[e.assurance]}</span>
          <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-text-secondary">{confidenceLabel(e.confidence)} · {formatConfidence(e.confidence)}</span>
        </div>
      </header>

      <div role="tablist" aria-label="Identity sections" className="mb-4 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`focus-ring -mb-px rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium ${tab === t ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>{tabLabel(t)}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-4" role="tabpanel">
          {e.lifecycle_reason && <p className="rounded-xl bg-bg-tertiary p-3 text-xs text-text-secondary">{state.label}: {e.lifecycle_reason}</p>}
          {e.merged_into_id && <Button size="sm" variant="secondary" onClick={() => onSelect(e.merged_into_id!)}>Open the surviving entity</Button>}

          {e.attributes_redacted ? (
            <p className="rounded-xl border border-dashed border-border p-3 text-sm text-text-secondary">Attributes are not shared with your account.</p>
          ) : (
            <dl className="grid gap-2 sm:grid-cols-2">
              {Object.entries(e.attributes).length === 0 && <p className="text-sm text-text-secondary">No attributes recorded.</p>}
              {Object.entries(e.attributes).map(([k, v]) => (
                <div key={k} className="rounded-xl bg-bg-primary p-2.5">
                  <dt className="text-[11px] uppercase tracking-wide text-text-secondary">{k.replace(/_/g, ' ')}</dt>
                  <dd className="break-words text-sm text-text-primary">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
            </dl>
          )}

          {dossier.refs.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">External references</h3>
              <ul className="space-y-1">
                {dossier.refs.map((r) => (
                  <li key={r.id} className={`flex flex-wrap gap-x-2 rounded-lg bg-bg-primary px-2.5 py-1.5 text-xs ${r.status === 'retired' ? 'opacity-50' : ''}`}>
                    <span className="font-medium text-text-primary">{r.system}</span><span className="text-text-secondary">{r.ref_type}</span><span className="break-all font-mono text-text-secondary">{r.ref_value}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {p.write && !terminal && (
            <form className="space-y-2 rounded-xl border border-border p-3" onSubmit={(ev) => {
              ev.preventDefault();
              const parsed = parseAttributesInput(editAttrs);
              if ('error' in parsed) return toast(parsed.error, 'error');
              void run(async () => {
                // send nulls for removed keys so the server deletes them
                const removed = Object.keys(e.attributes).filter((k) => !(k in parsed.value));
                const patch: Record<string, unknown> = { ...parsed.value };
                for (const k of removed) patch[k] = null;
                await updateIdentity(e.id, { name: editName, attributes: patch, expectedVersion: e.version, source: { source_type: 'user_entry', method: 'dashboard' } });
              }, 'Saved');
            }}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Edit</h3>
              <input aria-label="Display name" value={editName} maxLength={200} onChange={(ev) => setEditName(ev.target.value)} className={FIELD} />
              {!e.attributes_redacted && <textarea aria-label="Attributes JSON" rows={5} value={editAttrs} onChange={(ev) => setEditAttrs(ev.target.value)} className={`${FIELD} font-mono text-xs`} />}
              <Button type="submit" size="sm" disabled={busy}>Save changes</Button>
            </form>
          )}

          {p.write && !terminal && (
            <form className="grid grid-cols-[1fr_1fr_2fr_auto] gap-2" onSubmit={(ev) => {
              ev.preventDefault();
              void run(async () => { await addIdentityRef(e.id, { system: refForm.system.trim().toLowerCase(), ref_type: refForm.type.trim().toLowerCase(), ref_value: refForm.value.trim() }); setRefForm({ system: '', type: '', value: '' }); }, 'Reference added');
            }}>
              <input aria-label="Reference system" placeholder="system" value={refForm.system} onChange={(ev) => setRefForm({ ...refForm, system: ev.target.value })} className={FIELD} required />
              <input aria-label="Reference type" placeholder="type" value={refForm.type} onChange={(ev) => setRefForm({ ...refForm, type: ev.target.value })} className={FIELD} required />
              <input aria-label="Reference value" placeholder="value" value={refForm.value} onChange={(ev) => setRefForm({ ...refForm, value: ev.target.value })} className={FIELD} required />
              <Button type="submit" size="sm" variant="secondary" disabled={busy}>Add ref</Button>
            </form>
          )}

          {p.manage && !terminal && (
            <div className="space-y-3 rounded-xl border border-border p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Lifecycle</h3>
              {next.length > 0 && (
                <>
                  {needsReason && <input aria-label="Reason" placeholder="Reason (required to suspend, dispute or retire)" value={reason} onChange={(ev) => setReason(ev.target.value)} className={FIELD} />}
                  <div className="flex flex-wrap gap-2">
                    {next.map((to) => (
                      <Button key={to} size="sm" variant="secondary" disabled={busy || (transitionNeedsReason(to) && reason.trim().length < 3)}
                        onClick={() => void run(() => transitionIdentity(e.id, to as LifecycleState, reason), `Now ${LIFECYCLE_META[to].label.toLowerCase()}`)}>
                        {to === 'active' ? 'Activate' : LIFECYCLE_META[to].label}
                      </Button>
                    ))}
                  </div>
                </>
              )}
              <details className="text-sm">
                <summary className="focus-ring cursor-pointer rounded text-xs font-medium text-danger">Merge duplicate or erase personal data</summary>
                <div className="mt-2 space-y-2">
                  <p className="text-xs text-text-secondary">Merge folds another {meta.label.toLowerCase()} into this one. Its ID keeps resolving here forever.</p>
                  <div className="flex gap-2">
                    <input aria-label="Duplicate universal ID" placeholder="Duplicate's universal ID (VRK-…)" value={mergeUid} onChange={(ev) => setMergeUid(ev.target.value)} className={FIELD} />
                    <Button size="sm" variant="secondary" disabled={busy || !looksLikeUid(mergeUid) || reason.trim().length < 3}
                      onClick={() => void run(async () => {
                        const dup = await resolveIdentityUid(mergeUid);
                        if (!dup.found || !dup.entity) throw new Error('entity_not_found');
                        await mergeIdentities(e.id, dup.entity.id, reason); setMergeUid('');
                      }, 'Merged')}>Merge</Button>
                  </div>
                  <p className="text-xs text-text-secondary">Use the reason box above for the merge reason.</p>
                  <Button size="sm" variant="ghost" className="!text-danger" disabled={busy} onClick={() => setConfirm('erase')}>Erase personal data…</Button>
                </div>
              </details>
            </div>
          )}
        </div>
      )}

      {tab === 'relationships' && (
        <div className="space-y-3" role="tabpanel">
          {dossier.relationships.length === 0 && <p className="text-sm text-text-secondary">No relationships yet.</p>}
          <ul className="space-y-1.5">
            {dossier.relationships.map((r) => (
              <li key={r.id} className={`flex items-center justify-between gap-2 rounded-xl bg-bg-primary p-2.5 text-sm ${r.status === 'ended' ? 'opacity-50' : ''}`}>
                <button type="button" className="focus-ring min-w-0 rounded text-left" onClick={() => r.other_uid && onSelect(r.other_id)} disabled={!r.other_uid}>
                  <span className="text-xs text-text-secondary">{r.label} </span>
                  <span className="font-medium text-text-primary">{r.other_name}</span>
                  <span className="ml-1.5 text-[11px] text-text-secondary">{typeOf(r.other_type)}{r.status === 'ended' ? ' · ended' : ''}</span>
                </button>
                {r.status === 'active' && p.link && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => unlinkIdentities(r.id, 'Unlinked from dashboard'), 'Relationship ended')}>End</Button>
                )}
              </li>
            ))}
          </ul>
          {p.link && !terminal && (
            <div className="space-y-2 rounded-xl border border-border p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Link to another entity</h3>
              <div className="flex gap-2">
                <input aria-label="Target universal ID" placeholder="Target universal ID (VRK-…)" value={linkUid} onChange={(ev) => { setLinkUid(ev.target.value); setLinkOptions(null); }} className={FIELD} />
                <Button size="sm" variant="secondary" disabled={busy || !linkUid.trim()} onClick={() => void prepareLink()}>Find</Button>
              </div>
              {linkOptions && (
                <div className="flex gap-2">
                  <select aria-label="Relationship" value={linkRel} onChange={(ev) => setLinkRel(ev.target.value)} className={FIELD}>
                    {linkOptions.rels.map((r) => <option key={r.rel_type} value={r.rel_type}>{r.label}</option>)}
                  </select>
                  <Button size="sm" disabled={busy} onClick={() => void run(async () => { await linkIdentities(e.id, linkOptions.targetId, linkRel, { source_type: 'user_entry', method: 'dashboard' }); setLinkOptions(null); setLinkUid(''); }, 'Linked')}>Link</Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'provenance' && (
        <ul className="space-y-1.5" role="tabpanel">
          {dossier.provenance.length === 0 && <li className="text-sm text-text-secondary">No provenance recorded.</li>}
          {dossier.provenance.map((x) => (
            <li key={x.id} className="rounded-xl bg-bg-primary p-2.5 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-text-primary">{x.claim_path === '*' ? 'Identity' : x.claim_path.replace('rel:', 'Relationship: ').replace(/_/g, ' ')}</span>
                <span className="text-[11px] text-text-secondary">{formatConfidence(x.confidence)} · {relativeTime(x.recorded_at)}</span>
              </div>
              <p className="text-xs text-text-secondary">{SOURCE_LABELS[x.source_type] ?? x.source_type}{x.source_system ? ` · ${x.source_system}` : ''}{x.method ? ` · ${x.method}` : ''}{x.source_ref ? ` · ${x.source_ref}` : ''}</p>
            </li>
          ))}
        </ul>
      )}

      {tab === 'history' && (
        <div className="space-y-3" role="tabpanel">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => void verify()}>Verify tamper-evident chain</Button>
            {chain && (chain.valid
              ? <span className="flex items-center gap-1 text-xs text-success-500"><ShieldCheck size={14} aria-hidden="true" /> Intact · {chain.events} events verified</span>
              : <span role="alert" className="flex items-center gap-1 text-xs text-danger"><ShieldAlert size={14} aria-hidden="true" /> Chain broken at event #{chain.broken_at_seq ?? '?'}</span>)}
          </div>
          <ol className="space-y-1.5">
            {dossier.events.map((ev) => (
              <li key={ev.seq} className="rounded-xl bg-bg-primary p-2.5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-text-primary">#{ev.seq} · {EVENT_LABELS[ev.event_type] ?? ev.event_type}</span>
                  <span className="text-[11px] text-text-secondary">{ev.actor_type} · {relativeTime(ev.occurred_at)}</span>
                </div>
                {ev.reason && <p className="text-xs text-text-secondary">Reason: {ev.reason}</p>}
                {ev.diff_keys.length > 0 && <p className="text-xs text-text-secondary">Changed: {ev.diff_keys.join(', ')}</p>}
                <p className="mt-0.5 truncate font-mono text-[10px] text-text-secondary/70" title={ev.event_hash}>{ev.event_hash.slice(0, 24)}…</p>
              </li>
            ))}
          </ol>
        </div>
      )}

      {tab === 'access' && (
        <div className="space-y-3" role="tabpanel">
          <p className="text-xs text-text-secondary">Your account always has full control. Grants give another account or one of your agents limited, expiring, purpose-bound access.</p>
          {!p.manage ? <p className="text-sm text-text-secondary">Only owners and admins can view or change access.</p> : (
            <>
              {dossier.grants.length === 0 && <p className="text-sm text-text-secondary">No active grants.</p>}
              <ul className="space-y-1.5">
                {dossier.grants.map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-2 rounded-xl bg-bg-primary p-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="truncate text-text-primary">{g.grantee_kind === 'agent' ? 'Agent' : 'Account'} <span className="font-mono text-xs">{g.grantee_id.slice(0, 8)}…</span> · {g.actions.join(', ')}</p>
                      <p className="text-xs text-text-secondary">{g.purpose} · expires {relativeTime(g.expires_at)}</p>
                    </div>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => revokeIdentityGrant(g.id, 'Revoked from dashboard'), 'Access revoked')}>Revoke</Button>
                  </li>
                ))}
              </ul>
              {!terminal && e.scope === 'tenant' && (
                <form className="space-y-2 rounded-xl border border-border p-3" onSubmit={(ev) => {
                  ev.preventDefault();
                  void run(async () => {
                    await grantIdentityAccess({ entityId: e.id, kind: grant.kind, granteeId: grant.id.trim(), actions: grant.actions, purpose: grant.purpose, expiresAt: new Date(Date.now() + grant.days * 86400000).toISOString() });
                    setGrant({ ...grant, id: '', purpose: '' });
                  }, 'Access granted');
                }}>
                  <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
                    <select aria-label="Recipient kind" value={grant.kind} onChange={(ev) => setGrant({ ...grant, kind: ev.target.value as 'tenant' | 'agent' })} className={FIELD}>
                      <option value="tenant">Another account</option><option value="agent">One of my agents</option>
                    </select>
                    <input aria-label="Recipient ID" required placeholder={grant.kind === 'agent' ? 'Agent entity ID (uuid)' : 'Account ID (uuid)'} value={grant.id} onChange={(ev) => setGrant({ ...grant, id: ev.target.value })} className={FIELD} />
                  </div>
                  <div className="flex flex-wrap gap-3 text-xs text-text-secondary">
                    {['read', 'read_attributes', 'link', 'write'].map((a) => (
                      <label key={a} className="flex items-center gap-1.5">
                        <input type="checkbox" checked={grant.actions.includes(a)} onChange={(ev) => setGrant({ ...grant, actions: ev.target.checked ? [...grant.actions, a] : grant.actions.filter((x) => x !== a) })} />{a.replace('_', ' ')}
                      </label>
                    ))}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                    <input aria-label="Purpose" required minLength={3} maxLength={300} placeholder="Purpose (why is this shared?)" value={grant.purpose} onChange={(ev) => setGrant({ ...grant, purpose: ev.target.value })} className={FIELD} />
                    <select aria-label="Expires in" value={grant.days} onChange={(ev) => setGrant({ ...grant, days: Number(ev.target.value) })} className={FIELD}>
                      {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
                    </select>
                  </div>
                  <Button type="submit" size="sm" disabled={busy || grant.actions.length === 0}>Grant access</Button>
                </form>
              )}
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'erase'}
        title="Erase personal data?"
        description={`This permanently removes the name, attributes and reference values of ${shortUid(e.uid)}, ends its relationships and revokes all access. The ID stays reserved and the history chain stays verifiable. This cannot be undone.`}
        confirmPhrase="erase"
        confirmLabel="Erase"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          await run(() => eraseIdentity(e.id, reason.trim().length >= 3 ? reason : 'Erasure requested'), 'Personal data erased');
        }}
      />
    </section>
  );
}
