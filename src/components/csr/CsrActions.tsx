import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarPlus, FileText, Loader2, PhoneForwarded, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import {
  bookJobFromCall,
  createQuoteDraftFromCall,
  fetchTransferTargets,
  transferCall,
  type TransferTarget,
} from '@/lib/csrScreenPopApi';
import {
  buildSuggestedScript,
  suggestBookingSlot,
  toLocalInputValue,
  type DeskCall,
  type PrimaryAction,
  type ScreenPopData,
} from '@/lib/csrScreenPop';

type Panel = null | 'book' | 'transfer';

export function CsrActions({ ownerId, call, data }: { ownerId: string; call: DeskCall; data: ScreenPopData }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState<null | 'book' | 'quote' | 'transfer'>(null);

  // book form
  const [when, setWhen] = useState('');
  const [service, setService] = useState('');
  const [address, setAddress] = useState('');
  const [duration, setDuration] = useState(60);
  const [formError, setFormError] = useState<string | null>(null);

  // transfer
  const [targets, setTargets] = useState<TransferTarget[]>([]);
  const [targetKey, setTargetKey] = useState('forwarding');

  const primary: PrimaryAction = buildSuggestedScript(call, data, Date.now()).primaryAction;
  const callId = call.id;

  // Reset when the CSR switches calls.
  useEffect(() => {
    setPanel(null);
    setFormError(null);
  }, [callId]);

  const openBook = () => {
    setWhen(toLocalInputValue(suggestBookingSlot(new Date(), call.is_emergency)));
    setService(data.open_quotes.length ? '' : call.intent ?? '');
    setAddress(data.customer?.address ?? '');
    setFormError(null);
    setPanel('book');
  };

  const openTransfer = async () => {
    setPanel('transfer');
    if (targets.length === 0) setTargets(await fetchTransferTargets(ownerId));
  };

  const confirmBook = async () => {
    const date = new Date(when);
    if (Number.isNaN(date.getTime())) return setFormError('Choose a valid date and time.');
    if (date.getTime() < Date.now() - 5 * 60_000) return setFormError('That time is in the past.');
    setBusy('book');
    setFormError(null);
    try {
      await bookJobFromCall({ ownerId, call, data, scheduledAt: date, serviceType: service, address, durationMinutes: duration });
      toast('Job booked.', 'success');
      setPanel(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not book the job');
    } finally {
      setBusy(null);
    }
  };

  const quote = async () => {
    setBusy('quote');
    try {
      await createQuoteDraftFromCall(ownerId, call, data);
      toast('Draft quote created.', 'success');
      navigate('/dashboard/quotes');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the quote', 'error');
    } finally {
      setBusy(null);
    }
  };

  const confirmTransfer = async () => {
    const t = targets.find((x) => x.key === targetKey) ?? targets[0];
    if (!t) return;
    setBusy('transfer');
    try {
      const who = await transferCall(callId, t.target);
      toast(`Transferring to ${who}.`, 'success');
      setPanel(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Transfer failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  const disabled = call.ended || busy !== null;
  const variant = (a: PrimaryAction) => (primary === a ? 'primary' : 'secondary');

  return (
    <div className="space-y-3" data-testid="csr-actions">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={variant('book')} onClick={openBook} disabled={disabled} aria-expanded={panel === 'book'}>
          <CalendarPlus className="h-4 w-4" aria-hidden="true" /> Book
        </Button>
        <Button size="sm" variant={variant('quote')} onClick={quote} disabled={disabled}>
          {busy === 'quote' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FileText className="h-4 w-4" aria-hidden="true" />} Quote
        </Button>
        <Button size="sm" variant={variant('transfer')} onClick={openTransfer} disabled={disabled} aria-expanded={panel === 'transfer'}>
          <PhoneForwarded className="h-4 w-4" aria-hidden="true" /> Transfer
        </Button>
      </div>
      {call.ended && <p className="text-xs text-text-secondary">Call ended — Book and Quote stay available from the customer record; transfer is disabled.</p>}

      {panel === 'book' && (
        <div className="space-y-3 rounded-xl border border-border bg-bg-secondary p-4" role="group" aria-label="Book a job">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-text-primary">Book a job</p>
            <button type="button" className="focus-ring rounded p-1 text-text-secondary" onClick={() => setPanel(null)} aria-label="Close booking form">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Date & time" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            <Input label="Duration (min)" type="number" min={15} step={15} value={duration} onChange={(e) => setDuration(Math.max(15, Number(e.target.value) || 60))} />
            <Input label="Service" value={service} onChange={(e) => setService(e.target.value)} placeholder="e.g. Furnace repair" />
            <Input label="Address" value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
          <Button size="sm" variant="primary" onClick={confirmBook} disabled={busy === 'book'}>
            {busy === 'book' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Confirm booking
          </Button>
        </div>
      )}

      {panel === 'transfer' && (
        <div className="space-y-3 rounded-xl border border-border bg-bg-secondary p-4" role="group" aria-label="Transfer the call">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-text-primary">Transfer this call to</p>
            <button type="button" className="focus-ring rounded p-1 text-text-secondary" onClick={() => setPanel(null)} aria-label="Close transfer panel">
              <X className="h-4 w-4" />
            </button>
          </div>
          <select
            className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary"
            value={targetKey}
            onChange={(e) => setTargetKey(e.target.value)}
            aria-label="Transfer destination"
          >
            {targets.length === 0 && <option value="forwarding">Main line / on-call</option>}
            {targets.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
          <Button size="sm" variant="primary" onClick={confirmTransfer} disabled={busy === 'transfer'}>
            {busy === 'transfer' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Transfer now
          </Button>
        </div>
      )}
    </div>
  );
}
