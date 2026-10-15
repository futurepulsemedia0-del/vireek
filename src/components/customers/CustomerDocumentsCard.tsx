import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderLock, Plus, Paperclip, TriangleAlert } from 'lucide-react';
import { DocumentFormModal } from '@/components/documents/DocumentFormModal';
import { useDocumentsScope } from '@/hooks/useDocumentsScope';
import {
  DOCUMENT_CATEGORY_LABELS,
  EXPIRY_STATE_LABELS,
  EXPIRY_STATE_STYLES,
  expirySortKey,
  getExpiryState,
  type DocumentRecord,
} from '@/lib/documents';
import { fetchDocuments } from '@/lib/documentsApi';

const VISIBLE_LIMIT = 5;

/** Documents attached to one customer (contracts, signed agreements, permits for their property…). */
export function CustomerDocumentsCard({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const { accountOwnerId, canManage, ready } = useDocumentsScope();
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    setError(false);
    try {
      const rows = await fetchDocuments(accountOwnerId, customerId);
      setDocs(rows.sort((a, b) => expirySortKey(a) - expirySortKey(b)));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId, customerId]);

  useEffect(() => {
    if (!ready) return;
    setLoading(true);
    void load();
  }, [ready, load]);

  if (!ready) return null;

  return (
    <section className="mb-6" aria-labelledby="customer-docs-heading">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2
          id="customer-docs-heading"
          className="flex items-center gap-1.5 text-sm font-semibold text-text-primary"
        >
          <FolderLock size={14} /> Documents
          {docs.length > 0 && (
            <span className="text-xs font-normal text-text-secondary">({docs.length})</span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {docs.length > VISIBLE_LIMIT && (
            <Link
              to={`/dashboard/documents?customer=${customerId}`}
              className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
            >
              View all
            </Link>
          )}
          {canManage && (
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-accent/50 hover:text-accent"
            >
              <Plus size={13} /> Attach document
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-bg-tertiary" />
          ))}
        </div>
      ) : error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary p-4"
        >
          <p className="flex items-center gap-2 text-xs text-text-secondary">
            <TriangleAlert size={14} className="text-danger" /> Couldn’t load documents.
          </p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void load();
            }}
            className="focus-ring rounded-lg px-3 py-1 text-xs font-medium text-accent hover:bg-accent/10"
          >
            Retry
          </button>
        </div>
      ) : docs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-5 text-center">
          <p className="text-xs text-text-secondary">
            No documents attached to this customer yet.
            {canManage ? ' Attach contracts, agreements or permits for their property.' : ''}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {docs.slice(0, VISIBLE_LIMIT).map((d) => {
            const state = getExpiryState(d.expires_on, d.alert_days);
            return (
              <li key={d.id}>
                <Link
                  to={`/dashboard/documents?doc=${d.id}`}
                  className="focus-ring flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary p-3 transition-colors hover:border-accent/40"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">{d.title}</p>
                    <p className="mt-0.5 flex items-center gap-2 text-[11px] text-text-secondary">
                      <span>{DOCUMENT_CATEGORY_LABELS[d.category]}</span>
                      {d.current_file_name && <Paperclip size={11} aria-label="Has file" />}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${EXPIRY_STATE_STYLES[state]}`}
                  >
                    {EXPIRY_STATE_LABELS[state]}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {accountOwnerId && (
        <DocumentFormModal
          open={formOpen}
          ownerId={accountOwnerId}
          customers={[{ id: customerId, name: customerName }]}
          lockedCustomerId={customerId}
          onClose={() => setFormOpen(false)}
          onSaved={() => {
            setFormOpen(false);
            void load();
          }}
        />
      )}
    </section>
  );
}
