/**
 * Consent ledger: the latest consent state per contact and type, with full
 * history. The ledger is append-only — withdrawing consent adds a new row.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { History, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import {
  CONSENT_PAGE_SIZE, CONSENT_SOURCE_LABELS, CONSENT_TYPE_LABELS, ComplianceError, contactLabel, fetchConsentHistory,
  fetchConsents, recordConsent, type ConsentHistoryRow, type ConsentRow, type ConsentType,
} from '@/lib/complianceRules';

const selectClass =
  'focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary transition-colors focus-visible:border-accent';
const TYPES = Object.keys(CONSENT_TYPE_LABELS) as ConsentType[];
const SOURCES = ['manual', 'web_form', 'ivr_verbal', 'sms_reply', 'import'] as const;

const msg = (e: unknown) => (e instanceof ComplianceError ? e.message : 'Something went wrong. Please try again.');

export function ConsentLedger({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const [type, setType] = useState<ConsentType | ''>('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [rows, setRows] = useState<ConsentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ row: ConsentRow; items: ConsentHistoryRow[] | null } | null>(null);
  const req = useRef(0);

  // Record form
  const [fType, setFType] = useState<ConsentType>('marketing_sms');
  const [fGranted, setFGranted] = useState(true);
  const [fPhone, setFPhone] = useState('');
  const [fEmail, setFEmail] = useState('');
  const [fSource, setFSource] = useState<string>('manual');
  const [fNotes, setFNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    const id = ++req.current;
    setLoading(true); setError(null);
    try {
      const res = await fetchConsents(type || null, debounced, 0);
      if (id !== req.current) return;
      setRows(res.rows); setTotal(res.total);
    } catch (e) {
      if (id === req.current) setError(msg(e));
    } finally {
      if (id === req.current) setLoading(false);
    }
  }, [type, debounced]);

  useEffect(() => { void load(); }, [load]);

  const loadMore = async () => {
    const id = req.current;
    setMoreBusy(true);
    try {
      const res = await fetchConsents(type || null, debounced, rows.length);
      if (id !== req.current) return;
      setRows((r) => [...r, ...res.rows.filter((x) => !r.some((y) => y.id === x.id))]); setTotal(res.total);
    } catch (e) { toast(msg(e), 'error'); } finally { setMoreBusy(false); }
  };

  const openHistory = async (row: ConsentRow) => {
    setHistory({ row, items: null });
    try {
      const items = await fetchConsentHistory(row.consent_type, row.contact_phone, row.contact_email);
      setHistory({ row, items });
    } catch (e) { toast(msg(e), 'error'); setHistory(null); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!fPhone.trim() && !fEmail.trim()) return setFormError('Enter a phone number or an email address.');
    setSaving(true);
    try {
      await recordConsent({ type: fType, granted: fGranted, phone: fPhone, email: fEmail, source: fSource, notes: fNotes });
      toast(fGranted ? 'Consent recorded.' : 'Withdrawal recorded.', 'success');
      setFPhone(''); setFEmail(''); setFNotes('');
      await load();
    } catch (err) { setFormError(msg(err)); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-5">
      {canEdit && (
        <form onSubmit={submit} className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4" aria-label="Record consent">
          <h3 className="text-sm font-semibold text-text-primary">Record consent or a withdrawal</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label htmlFor="cl-type" className="mb-1.5 block text-sm font-medium text-text-primary">Consent for</label>
              <select id="cl-type" className={`${selectClass} w-full`} value={fType} onChange={(e) => setFType(e.target.value as ConsentType)}>
                {TYPES.map((t) => <option key={t} value={t}>{CONSENT_TYPE_LABELS[t]}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="cl-action" className="mb-1.5 block text-sm font-medium text-text-primary">Action</label>
              <select id="cl-action" className={`${selectClass} w-full`} value={fGranted ? 'grant' : 'revoke'} onChange={(e) => setFGranted(e.target.value === 'grant')}>
                <option value="grant">Customer agreed</option><option value="revoke">Customer withdrew</option>
              </select>
            </div>
            <Input label="Phone" inputMode="tel" value={fPhone} onChange={(e) => setFPhone(e.target.value)} />
            <Input label="Email" type="email" value={fEmail} onChange={(e) => setFEmail(e.target.value)} />
            <div>
              <label htmlFor="cl-source" className="mb-1.5 block text-sm font-medium text-text-primary">How was it given?</label>
              <select id="cl-source" className={`${selectClass} w-full`} value={fSource} onChange={(e) => setFSource(e.target.value)}>
                {SOURCES.map((s) => <option key={s} value={s}>{CONSENT_SOURCE_LABELS[s]}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <Input label="Notes (optional)" maxLength={500} value={fNotes} onChange={(e) => setFNotes(e.target.value)} />
            </div>
          </div>
          {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
          <Button type="submit" size="sm" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Save to ledger</Button>
        </form>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1"><Input label="Search phone or email" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div>
          <label htmlFor="cl-filter" className="mb-1.5 block text-sm font-medium text-text-primary">Type</label>
          <select id="cl-filter" className={selectClass} value={type} onChange={(e) => setType(e.target.value as ConsentType | '')}>
            <option value="">All types</option>
            {TYPES.map((t) => <option key={t} value={t}>{CONSENT_TYPE_LABELS[t]}</option>)}
          </select>
        </div>
      </div>

      {loading ? <SkeletonCardList count={4} rows={2} />
        : error ? <EmptyState icon={TriangleAlert} title="Couldn't load the consent ledger" description={error} action={{ label: 'Try again', onClick: () => void load() }} />
        : rows.length === 0 ? <EmptyState icon={ShieldCheck} title={debounced || type ? 'No matching consent records' : 'No consent records yet'} description="Consent you record here, and consent captured by calls and text replies, appears in this ledger." />
        : (
          <>
            <p className="text-xs text-text-secondary">{total} contact/type pair{total === 1 ? '' : 's'} · showing the latest state of each</p>
            <ul className="space-y-2">
              {rows.map((r) => {
                const state = !r.granted ? 'Withdrawn' : r.expired ? 'Expired' : 'Granted';
                const good = state === 'Granted';
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-bg-secondary p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary">{contactLabel(r)}</p>
                      <p className="text-xs text-text-secondary">
                        {CONSENT_TYPE_LABELS[r.consent_type]} · {CONSENT_SOURCE_LABELS[r.source] ?? r.source} · {new Date(r.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${good ? 'bg-success-500/10 text-success-500' : 'bg-danger/10 text-danger'}`}>{state}</span>
                    <Button type="button" variant="ghost" size="sm" aria-label={`History for ${contactLabel(r)}`} onClick={() => void openHistory(r)}>
                      <History className="h-4 w-4" aria-hidden /> History
                    </Button>
                  </li>
                );
              })}
            </ul>
            {rows.length < total && (
              <Button type="button" variant="secondary" size="sm" disabled={moreBusy} onClick={() => void loadMore()}>
                {moreBusy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Load more ({Math.min(CONSENT_PAGE_SIZE, total - rows.length)} of {total - rows.length})
              </Button>
            )}
          </>
        )}

      {history && (
        <div role="dialog" aria-modal="true" aria-label="Consent history" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setHistory(null)}>
          <div className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-bg-secondary p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-text-primary">{contactLabel(history.row)}</h3>
            <p className="text-xs text-text-secondary">{CONSENT_TYPE_LABELS[history.row.consent_type]} — newest first</p>
            {history.items === null ? <p className="mt-4 text-sm text-text-secondary">Loading…</p> : (
              <ol className="mt-3 space-y-2">
                {history.items.map((h) => (
                  <li key={h.id} className="rounded-lg border border-border bg-bg-primary p-2.5 text-sm">
                    <span className={h.granted ? 'text-success-500' : 'text-danger'}>{h.granted ? 'Granted' : 'Withdrawn'}</span>
                    <span className="text-text-secondary"> · {CONSENT_SOURCE_LABELS[h.source] ?? h.source} · {new Date(h.created_at).toLocaleString()}</span>
                    {h.notes && <p className="mt-0.5 text-xs text-text-secondary">{h.notes}</p>}
                  </li>
                ))}
              </ol>
            )}
            <div className="mt-4 text-right"><Button type="button" variant="secondary" size="sm" onClick={() => setHistory(null)}>Close</Button></div>
          </div>
        </div>
      )}
    </div>
  );
}
