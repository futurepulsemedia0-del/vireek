/**
 * Dashboard modal to send a document out for Native E-Signature. Works
 * for any document type — pass documentType/documentId/title from the
 * calling page (contract, quote, or a one-off custom document).
 */

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Plus, Send, Trash2, X } from 'lucide-react';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import {
  createSignatureRequest,
  SignerRole,
  SignatureDocumentType,
  CreateSignatureRequestResult,
  SIGNER_ROLE_LABELS,
} from '@/lib/signatures';

interface SignerRow {
  name: string;
  email: string;
  phone: string;
  role: SignerRole;
}

interface RequestSignatureModalProps {
  open: boolean;
  onClose: () => void;
  documentType: SignatureDocumentType;
  documentId: string;
  title: string;
  documentSummary?: string;
  customerId?: string | null;
  defaultSigner?: { name: string; email?: string; phone?: string };
  onSent?: (result: CreateSignatureRequestResult) => void;
}

const emptySigner = (): SignerRow => ({ name: '', email: '', phone: '', role: 'signer' });

export function RequestSignatureModal({
  open,
  onClose,
  documentType,
  documentId,
  title,
  documentSummary,
  customerId,
  defaultSigner,
  onSent,
}: RequestSignatureModalProps) {
  const { toast } = useToast();
  const dialogRef = useFocusTrap(open);
  useEscapeToClose(open, onClose);

  const [signers, setSigners] = useState<SignerRow[]>([
    defaultSigner
      ? { name: defaultSigner.name, email: defaultSigner.email || '', phone: defaultSigner.phone || '', role: 'signer' }
      : emptySigner(),
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const updateSigner = (i: number, patch: Partial<SignerRow>) => {
    setSigners((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };

  const addSigner = () => setSigners((prev) => [...prev, { ...emptySigner(), role: 'company_rep' }]);
  const removeSigner = (i: number) => setSigners((prev) => prev.filter((_, idx) => idx !== i));

  const canSubmit = signers.every((s) => s.name.trim() && (s.email.trim() || s.phone.trim()));

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createSignatureRequest({
        document_type: documentType,
        document_id: documentId,
        customer_id: customerId,
        title,
        document_summary: documentSummary,
        signers: signers.map((s) => ({
          name: s.name.trim(),
          email: s.email.trim() || undefined,
          phone: s.phone.trim() || undefined,
          role: s.role,
        })),
      });
      toast('Signature request sent.', 'success');
      onSent?.(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the signature request.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
        className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      >
        <motion.div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="request-signature-title"
          initial={{ opacity: 0, scale: 0.96, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 8 }}
          transition={{ duration: 0.2 }}
          onClick={(e) => e.stopPropagation()}
          className="z-[120] max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border/80 bg-bg-secondary p-6 shadow-card-hover dark:shadow-card-hover-dark"
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 id="request-signature-title" className="text-lg font-semibold text-text-primary">
                Send for e-signature
              </h2>
              <p className="mt-0.5 text-sm text-text-secondary">{title}</p>
            </div>
            <button type="button" onClick={onClose} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="space-y-4">
            {signers.map((signer, i) => (
              <div key={i} className="rounded-xl border border-border bg-bg-primary p-3">
                <div className="mb-2 flex items-center justify-between">
                  <select
                    value={signer.role}
                    onChange={(e) => updateSigner(i, { role: e.target.value as SignerRole })}
                    className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1 text-xs text-text-secondary"
                  >
                    {(Object.keys(SIGNER_ROLE_LABELS) as SignerRole[]).map((role) => (
                      <option key={role} value={role}>
                        {SIGNER_ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                  {signers.length > 1 && (
                    <button type="button" onClick={() => removeSigner(i)} className="focus-ring text-text-secondary hover:text-danger" aria-label="Remove signer">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <Input placeholder="Full name" value={signer.name} onChange={(e) => updateSigner(i, { name: e.target.value })} />
                  <Input placeholder="Email" type="email" value={signer.email} onChange={(e) => updateSigner(i, { email: e.target.value })} />
                  <Input placeholder="Phone" value={signer.phone} onChange={(e) => updateSigner(i, { phone: e.target.value })} />
                </div>
              </div>
            ))}

            <button type="button" onClick={addSigner} className="focus-ring flex items-center gap-1.5 text-sm font-medium text-accent hover:brightness-110">
              <Plus size={15} /> Add another signer
            </button>

            {error && <p className="text-sm text-danger">{error}</p>}
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit || submitting}>
              <Send size={15} /> {submitting ? 'Sending…' : 'Send to sign'}
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
