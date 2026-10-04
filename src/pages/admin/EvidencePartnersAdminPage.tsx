import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, KeyRound, Network, Play } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { useSEO } from '@/lib/seo';
import {
  PARTNER_TYPES,
  PARTNER_TYPE_LABELS,
  fetchProducts,
  issuePartnerKey,
  listAccessLog,
  listPartnerKeys,
  listPartners,
  productsFor,
  revokePartnerKey,
  runEvidenceRelease,
  savePartner,
  summarizeUsage,
  type AccessLogRow,
  type PartnerKeyRow,
  type PartnerRow,
  type PartnerStatus,
  type PartnerType,
  type ProductRow,
} from '@/lib/evidenceMarketplace';

function SEO() {
  useSEO({
    title: 'Evidence Partners — Staff',
    description: 'Internal: manage Evidence Marketplace partners, keys and releases.',
    canonical: 'https://vireek.com/staff/evidence-partners',
  });
  return null;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

const STATUSES: PartnerStatus[] = ['pending', 'active', 'suspended'];
const input = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

interface Draft {
  id: string | null;
  name: string;
  partnerType: PartnerType;
  status: PartnerStatus;
  contactEmail: string;
  contractRef: string;
  contractExpiresAt: string;
  allowedProducts: string[];
  rateLimit: number;
}

const EMPTY: Draft = { id: null, name: '', partnerType: 'oem', status: 'pending', contactEmail: '', contractRef: '', contractExpiresAt: '', allowedProducts: [], rateLimit: 60 };

export function EvidencePartnersAdminPage() {
  const { toast } = useToast();
  const [partners, setPartners] = useState<PartnerRow[] | null>(null);
  const [keys, setKeys] = useState<PartnerKeyRow[]>([]);
  const [log, setLog] = useState<AccessLogRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<{ partner: string; raw: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, k, l, pr] = await Promise.all([listPartners(), listPartnerKeys(), listAccessLog(30), fetchProducts()]);
      setPartners(p);
      setKeys(k);
      setLog(l);
      setProducts(pr);
    } catch (e) {
      toast(errMessage(e), 'error');
      setPartners([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const usage = useMemo(() => summarizeUsage(log), [log]);
  const offered = useMemo(() => productsFor(draft.partnerType, products), [draft.partnerType, products]);

  const setType = (t: PartnerType) => {
    const allowed = new Set(productsFor(t, products).map((p) => p.slug));
    setDraft((d) => ({ ...d, partnerType: t, allowedProducts: d.allowedProducts.filter((s) => allowed.has(s)) }));
  };

  const save = async () => {
    setBusy(true);
    try {
      await savePartner({ ...draft, contractExpiresAt: draft.contractExpiresAt || null });
      toast('Partner saved');
      setDraft(EMPTY);
      await load();
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setBusy(false);
  };

  const issue = async (p: PartnerRow) => {
    setBusy(true);
    try {
      setNewKey({ partner: p.name, raw: await issuePartnerKey(p.id) });
      await load();
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setBusy(false);
  };

  const revoke = async (id: string) => {
    try {
      await revokePartnerKey(id);
      toast('Key revoked');
      await load();
    } catch (e) {
      toast(errMessage(e), 'error');
    }
  };

  const release = async () => {
    setBusy(true);
    try {
      const id = await runEvidenceRelease();
      toast(id ? 'Release published' : 'Nothing clears the privacy floors yet: no release created', id ? 'success' : 'info');
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setBusy(false);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Copy failed: select and copy manually', 'error');
    }
  };

  const valid = draft.name.trim().length >= 2 && draft.rateLimit >= 1 && draft.rateLimit <= 600;

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen bg-bg-primary px-6 pb-20 pt-28">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Network className="text-accent" size={22} />
              <h1 className="text-2xl font-bold tracking-tight text-text-primary">Evidence Partners</h1>
            </div>
            <Button size="sm" variant="secondary" onClick={() => void release()} disabled={busy}>
              <Play size={14} /> Run release now
            </Button>
          </div>
          <p className="mt-2 text-sm text-text-secondary">Releases run weekly. A partner receives only the latest immutable release, only for products its contract allows.</p>

          {newKey && (
            <div className="mt-5 rounded-2xl border border-warning-500/40 bg-warning-500/10 p-4">
              <p className="text-sm font-semibold text-text-primary">New key for {newKey.partner}: shown once</p>
              <p className="mt-1 text-xs text-text-secondary">Only the hash is stored. Send it over a secure channel; it cannot be shown again.</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg bg-bg-primary px-3 py-2 text-xs text-text-primary">{newKey.raw}</code>
                <Button size="sm" variant="secondary" onClick={() => void copy(newKey.raw)}>
                  <Copy size={14} /> Copy
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setNewKey(null)}>
                  Done
                </Button>
              </div>
            </div>
          )}

          <section className="mt-6 rounded-2xl border border-border bg-bg-secondary p-4" aria-label="Partner form">
            <p className="mb-3 text-sm font-semibold text-text-primary">{draft.id ? 'Edit partner' : 'Add partner'}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-xs text-text-secondary">
                Name
                <input className={`${input} mt-1`} value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="text-xs text-text-secondary">
                Type
                <select className={`${input} mt-1`} value={draft.partnerType} onChange={(e) => setType(e.target.value as PartnerType)}>
                  {PARTNER_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {PARTNER_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-text-secondary">
                Status
                <select className={`${input} mt-1`} value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as PartnerStatus })}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-text-secondary">
                Contact email
                <input className={`${input} mt-1`} type="email" value={draft.contactEmail} onChange={(e) => setDraft({ ...draft, contactEmail: e.target.value })} />
              </label>
              <label className="text-xs text-text-secondary">
                Contract reference
                <input className={`${input} mt-1`} value={draft.contractRef} maxLength={120} onChange={(e) => setDraft({ ...draft, contractRef: e.target.value })} />
              </label>
              <label className="text-xs text-text-secondary">
                Contract expires
                <input className={`${input} mt-1`} type="date" value={draft.contractExpiresAt} onChange={(e) => setDraft({ ...draft, contractExpiresAt: e.target.value })} />
              </label>
              <label className="text-xs text-text-secondary">
                Requests per minute (1-600)
                <input className={`${input} mt-1`} type="number" min={1} max={600} value={draft.rateLimit} onChange={(e) => setDraft({ ...draft, rateLimit: Number(e.target.value) })} />
              </label>
            </div>
            <fieldset className="mt-3">
              <legend className="text-xs text-text-secondary">Licensed products (only those valid for this partner type)</legend>
              <div className="mt-1 flex flex-wrap gap-3">
                {offered.map((p) => (
                  <label key={p.slug} className="flex items-center gap-1.5 text-xs text-text-primary">
                    <input
                      type="checkbox"
                      checked={draft.allowedProducts.includes(p.slug)}
                      onChange={(e) => setDraft({ ...draft, allowedProducts: e.target.checked ? [...draft.allowedProducts, p.slug] : draft.allowedProducts.filter((s) => s !== p.slug) })}
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="mt-4 flex gap-2">
              <Button size="sm" onClick={() => void save()} disabled={!valid || busy}>
                {draft.id ? 'Save changes' : 'Add partner'}
              </Button>
              {draft.id && (
                <Button size="sm" variant="secondary" onClick={() => setDraft(EMPTY)} disabled={busy}>
                  Cancel
                </Button>
              )}
            </div>
          </section>

          {partners === null ? (
            <div className="mt-10 flex justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
            </div>
          ) : partners.length === 0 ? (
            <p className="mt-6 text-sm text-text-secondary">No partners yet.</p>
          ) : (
            <div className="mt-6 space-y-3">
              {partners.map((p) => {
                const pk = keys.filter((k) => k.partner_id === p.id);
                const u = usage.get(p.id);
                return (
                  <div key={p.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-text-primary">
                          {p.name} <span className="font-normal text-text-secondary">· {PARTNER_TYPE_LABELS[p.partner_type]} · {p.status}</span>
                        </p>
                        <p className="text-[11px] text-text-secondary">
                          {p.contract_ref ?? 'No contract ref'} · expires {p.contract_expires_at ?? 'never'} · {p.rate_limit_per_minute}/min · products: {p.allowed_products.join(', ') || 'none'}
                        </p>
                        <p className="text-[11px] text-text-secondary">
                          30d: {u ? `${u.requests} requests, ${u.rows} rows, last ${new Date(u.lastAt as string).toLocaleDateString()}` : 'no requests'}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            setDraft({ id: p.id, name: p.name, partnerType: p.partner_type, status: p.status, contactEmail: p.contact_email ?? '', contractRef: p.contract_ref ?? '', contractExpiresAt: p.contract_expires_at ?? '', allowedProducts: p.allowed_products, rateLimit: p.rate_limit_per_minute })
                          }
                        >
                          Edit
                        </Button>
                        <Button size="sm" onClick={() => void issue(p)} disabled={busy || p.status !== 'active'} title={p.status !== 'active' ? 'Activate the partner first' : undefined}>
                          <KeyRound size={14} /> New key
                        </Button>
                      </div>
                    </div>
                    {pk.length > 0 && (
                      <ul className="mt-3 space-y-1">
                        {pk.map((k) => (
                          <li key={k.id} className="flex items-center justify-between gap-2 rounded-lg bg-bg-primary px-3 py-1.5 text-xs">
                            <span className="text-text-primary">
                              {k.key_prefix}… <span className="text-text-secondary">· created {new Date(k.created_at).toLocaleDateString()}{k.last_used_at ? ` · used ${new Date(k.last_used_at).toLocaleDateString()}` : ' · never used'}</span>
                            </span>
                            {k.revoked_at ? (
                              <span className="text-danger">revoked</span>
                            ) : (
                              <button type="button" onClick={() => void revoke(k.id)} className="focus-ring rounded px-2 py-0.5 text-danger hover:underline">
                                Revoke
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
