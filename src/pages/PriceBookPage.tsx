import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { DollarSign, Plus, Trash2, Pencil, X, Check, Plug, RefreshCw, Link2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { supabase } from '@/lib/supabase';
import {
  PriceBookItem,
  PriceBookFormState,
  PricingModel,
  PriceBookConnection,
  CrmProvider,
  CRM_PROVIDER_LABELS,
  PRICING_MODEL_LABELS,
  EMPTY_PRICE_BOOK_FORM,
  itemToForm,
  formToPayload,
  formatItemPrice,
} from '@/lib/priceBook';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

interface ServiceTitanFormState {
  client_id: string;
  client_secret: string;
  app_key: string;
  tenant_id: string;
}

const EMPTY_ST_FORM: ServiceTitanFormState = { client_id: '', client_secret: '', app_key: '', tenant_id: '' };

function CrmConnections({
  connections,
  onChanged,
}: {
  connections: PriceBookConnection[];
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [showStForm, setShowStForm] = useState(false);
  const [stForm, setStForm] = useState<ServiceTitanFormState>(EMPTY_ST_FORM);
  const [connectingSt, setConnectingSt] = useState(false);
  const [connectingJobber, setConnectingJobber] = useState(false);
  const [syncingProvider, setSyncingProvider] = useState<CrmProvider | null>(null);

  const byProvider = (p: CrmProvider) => connections.find((c) => c.provider === p);

  const handleConnectServiceTitan = async () => {
    if (!stForm.client_id || !stForm.client_secret || !stForm.app_key || !stForm.tenant_id) return;
    setConnectingSt(true);
    const { data, error } = await supabase.functions.invoke('price-book-connect-servicetitan', { body: stForm });
    setConnectingSt(false);
    if (error || data?.error) {
      toast(data?.error || 'Could not connect ServiceTitan', 'error');
      return;
    }
    toast(`ServiceTitan connected — synced ${data.synced} services.`, 'success');
    setShowStForm(false);
    setStForm(EMPTY_ST_FORM);
    onChanged();
  };

  const handleConnectJobber = async () => {
    setConnectingJobber(true);
    const { data, error } = await supabase.functions.invoke('jobber-oauth-start');
    setConnectingJobber(false);
    if (error || !data?.url) {
      toast(data?.error || 'Could not start the Jobber connection', 'error');
      return;
    }
    window.location.href = data.url;
  };

  const handleSync = async (provider: CrmProvider) => {
    setSyncingProvider(provider);
    const { data, error } = await supabase.functions.invoke('price-book-sync', { body: {} });
    setSyncingProvider(null);
    if (error || data?.error) {
      toast(data?.error || 'Sync failed', 'error');
      return;
    }
    toast('Price book synced.', 'success');
    onChanged();
  };

  return (
    <div className="mb-8 rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="mb-3 flex items-center gap-2">
        <Plug size={16} className="text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">Sync from your CRM</h2>
      </div>
      <p className="mb-3 text-xs text-text-secondary">
        Already keep prices in ServiceTitan or Jobber? Connect it here instead of re-entering everything by hand —
        Sarah quotes whichever prices are freshest.
      </p>

      <div className="space-y-2">
        {(['service_titan', 'jobber'] as CrmProvider[]).map((provider) => {
          const conn = byProvider(provider);
          return (
            <div key={provider} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary px-4 py-3">
              <div>
                <p className="text-sm font-medium text-text-primary">{CRM_PROVIDER_LABELS[provider]}</p>
                {conn ? (
                  <p className="text-xs text-text-secondary">
                    {conn.status === 'connected' && conn.last_synced_at
                      ? `Last synced ${new Date(conn.last_synced_at).toLocaleString()}`
                      : conn.status === 'error'
                        ? `Connection error: ${conn.last_sync_error ?? 'unknown error'}`
                        : 'Not synced yet'}
                  </p>
                ) : (
                  <p className="text-xs text-text-secondary">Not connected</p>
                )}
              </div>
              {conn ? (
                <button
                  type="button"
                  onClick={() => handleSync(provider)}
                  disabled={syncingProvider === provider}
                  className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                >
                  <RefreshCw size={12} className={syncingProvider === provider ? 'animate-spin' : ''} /> Sync now
                </button>
              ) : provider === 'service_titan' ? (
                <button
                  type="button"
                  onClick={() => setShowStForm((v) => !v)}
                  className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-all hover:brightness-110"
                >
                  <Link2 size={12} /> Connect
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleConnectJobber}
                  disabled={connectingJobber}
                  className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
                >
                  <Link2 size={12} /> Connect
                </button>
              )}
            </div>
          );
        })}
      </div>

      {showStForm && (
        <div className="mt-3 rounded-xl border border-border bg-bg-primary p-4">
          <p className="mb-3 text-xs text-text-secondary">
            From your ServiceTitan developer app (My Apps → your app): Client ID, Client Secret, App Key, and your Tenant ID.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input type="text" value={stForm.client_id} onChange={(e) => setStForm((f) => ({ ...f, client_id: e.target.value }))} placeholder="Client ID" className={inputClass} />
            <input type="password" value={stForm.client_secret} onChange={(e) => setStForm((f) => ({ ...f, client_secret: e.target.value }))} placeholder="Client Secret" className={inputClass} />
            <input type="text" value={stForm.app_key} onChange={(e) => setStForm((f) => ({ ...f, app_key: e.target.value }))} placeholder="App Key" className={inputClass} />
            <input type="text" value={stForm.tenant_id} onChange={(e) => setStForm((f) => ({ ...f, tenant_id: e.target.value }))} placeholder="Tenant ID" className={inputClass} />
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setShowStForm(false)} className="focus-ring rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConnectServiceTitan}
              disabled={connectingSt}
              className="focus-ring rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
            >
              {connectingSt ? 'Connecting…' : 'Connect ServiceTitan'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PriceItemForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: PriceBookFormState;
  onCancel: () => void;
  onSave: (form: PriceBookFormState) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);

  const canSave = form.service_name.trim() && form.price.trim() && (form.pricing_model !== 'range' || form.price_max.trim());

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <input type="text" value={form.service_name} onChange={(e) => setForm((f) => ({ ...f, service_name: e.target.value }))} placeholder="Service name, e.g. Drain Cleaning" className={inputClass} />
        <input type="text" value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} placeholder="Category (optional), e.g. Plumbing" className={inputClass} />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <select value={form.pricing_model} onChange={(e) => setForm((f) => ({ ...f, pricing_model: e.target.value as PricingModel }))} className={inputClass}>
          {(Object.keys(PRICING_MODEL_LABELS) as PricingModel[]).map((m) => (
            <option key={m} value={m}>
              {PRICING_MODEL_LABELS[m]}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={0}
          step="0.01"
          value={form.price}
          onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
          placeholder={form.pricing_model === 'range' ? 'From ($)' : 'Price ($)'}
          className={inputClass}
        />
        {form.pricing_model === 'range' && (
          <input type="number" min={0} step="0.01" value={form.price_max} onChange={(e) => setForm((f) => ({ ...f, price_max: e.target.value }))} placeholder="To ($)" className={inputClass} />
        )}
        <input type="text" value={form.unit_label} onChange={(e) => setForm((f) => ({ ...f, unit_label: e.target.value }))} placeholder="Unit (optional), e.g. per hour" className={inputClass} />
      </div>

      <input
        type="number"
        min={0}
        step="0.01"
        value={form.cost}
        onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))}
        placeholder="Your cost (optional, $) — what this actually costs you, not the customer price"
        className={`${inputClass} mt-3`}
      />

      <input
        type="text"
        value={form.keywords}
        onChange={(e) => setForm((f) => ({ ...f, keywords: e.target.value }))}
        placeholder="How customers say it (comma-separated), e.g. clogged drain, slow drain"
        className={`${inputClass} mt-3`}
      />
      <textarea
        value={form.description}
        onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        placeholder="Notes for your team (optional) — not read aloud on calls"
        rows={2}
        className={`${inputClass} mt-3`}
      />

      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="focus-ring flex items-center gap-1 rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
          <X size={14} /> Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !canSave}
          className="focus-ring flex items-center gap-1 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
        >
          <Check size={14} /> Save item
        </button>
      </div>
    </div>
  );
}

export function PriceBookPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [items, setItems] = useState<PriceBookItem[]>([]);
  const [connections, setConnections] = useState<PriceBookConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  const fetchItems = useCallback(async () => {
    setLoading(true);
    const [itemsRes, connectionsRes] = await Promise.all([
      supabase.from('price_book_items').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: false }),
      supabase.rpc('get_price_book_connections'),
    ]);

    if (itemsRes.error) {
      toast('Failed to load your price book', 'error');
    } else {
      setItems((itemsRes.data as PriceBookItem[]) || []);
    }
    setConnections((connectionsRes.data as PriceBookConnection[]) || []);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    if (user) fetchItems();
  }, [user, fetchItems]);

  useEffect(() => {
    const jobberResult = searchParams.get('jobber');
    if (!jobberResult) return;
    if (jobberResult === 'connected') toast('Jobber connected.', 'success');
    else if (jobberResult === 'connected_with_errors') toast('Jobber connected, but the first sync had errors — try "Sync now".', 'info');
    else toast('Could not connect Jobber — please try again.', 'error');
    searchParams.delete('jobber');
    searchParams.delete('synced');
    searchParams.delete('reason');
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams, toast]);

  const categories = useMemo(
    () => Array.from(new Set(items.map((i) => i.category).filter((c): c is string => Boolean(c)))).sort(),
    [items],
  );

  const stats = useMemo(
    () => ({ total: items.length, active: items.filter((i) => i.active).length, categories: categories.length }),
    [items, categories],
  );

  const filteredItems = items.filter((i) => categoryFilter === 'all' || i.category === categoryFilter);

  const handleSave = async (form: PriceBookFormState, itemId?: string) => {
    if (!user) return;
    let payload;
    try {
      payload = formToPayload(form, user.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save this item', 'error');
      return;
    }

    const query = itemId
      ? supabase.from('price_book_items').update(payload).eq('id', itemId)
      : supabase.from('price_book_items').insert(payload);

    const { error } = await query;
    if (error) {
      toast('Could not save this item', 'error');
      return;
    }
    toast('Price saved', 'success');
    setAdding(false);
    setEditingId(null);
    fetchItems();
  };

  const handleToggleActive = async (item: PriceBookItem) => {
    const { error } = await supabase.from('price_book_items').update({ active: !item.active }).eq('id', item.id);
    if (error) {
      toast('Could not update this item', 'error');
      return;
    }
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, active: !i.active } : i)));
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    const { error } = await supabase.from('price_book_items').delete().eq('id', deletingId);
    if (error) {
      toast('Could not delete this item', 'error');
    } else {
      setItems((prev) => prev.filter((i) => i.id !== deletingId));
      toast('Item deleted', 'success');
    }
    setDeletingId(null);
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <DollarSign size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Live Price Book</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Sarah quotes real prices from this list during calls instead of guessing or promising a callback.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <>
            <CrmConnections connections={connections} onChanged={fetchItems} />

            <div className="mb-8 grid grid-cols-3 gap-3">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{stats.total}</p>
                <p className="text-xs text-text-secondary">Priced services</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{stats.active}</p>
                <p className="text-xs text-text-secondary">Live on calls</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{stats.categories}</p>
                <p className="text-xs text-text-secondary">Categories</p>
              </div>
            </div>

            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                {(['all', ...categories] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategoryFilter(c)}
                    className={`focus-ring rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                      categoryFilter === c ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
              {!adding && (
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="focus-ring flex items-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
                >
                  <Plus size={14} /> Add price
                </button>
              )}
            </div>

            {adding && (
              <div className="mb-3">
                <PriceItemForm initial={EMPTY_PRICE_BOOK_FORM} onCancel={() => setAdding(false)} onSave={(form) => handleSave(form)} />
              </div>
            )}

            {filteredItems.length === 0 && !adding ? (
              <div className="rounded-2xl border border-dashed border-border py-10 text-center">
                <p className="text-sm text-text-secondary">No prices yet — add your services so Sarah can quote them live on calls.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredItems.map((item) =>
                  editingId === item.id ? (
                    <PriceItemForm key={item.id} initial={itemToForm(item)} onCancel={() => setEditingId(null)} onSave={(form) => handleSave(form, item.id)} />
                  ) : (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`rounded-xl border p-4 ${item.active ? 'border-border bg-bg-secondary' : 'border-border/50 bg-bg-secondary/50 opacity-60'}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-text-primary">
                            {item.service_name}{' '}
                            <span className="font-normal text-text-secondary">— {formatItemPrice(item)}</span>
                            {item.source !== 'manual' && (
                              <span className="ml-2 rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium text-text-secondary">
                                via {CRM_PROVIDER_LABELS[item.source]}
                              </span>
                            )}
                          </p>
                          {item.category && <p className="mt-0.5 text-xs text-text-secondary">{item.category}</p>}
                          {item.keywords.length > 0 && <p className="mt-1 text-xs text-text-secondary/70">Matches: {item.keywords.join(', ')}</p>}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleToggleActive(item)}
                            className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                          >
                            {item.active ? 'Deactivate' : 'Activate'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(item.id)}
                            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                            aria-label="Edit price"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeletingId(item.id)}
                            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger"
                            aria-label="Delete price"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  ),
                )}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deletingId)}
        title="Delete this price?"
        description="Sarah will no longer be able to quote this service on live calls."
        confirmLabel="Yes, delete this"
        onConfirm={handleDelete}
        onCancel={() => setDeletingId(null)}
      />
    </DashboardLayout>
  );
}
