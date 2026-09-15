import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Phone,
  PhoneCall,
  Plus,
  Search,
  Star,
  Copy,
  Trash2,
  X,
  Check,
  ArrowLeftRight,
  ShoppingCart,
  Wrench,
  MapPin,
  MessageSquare,
  Loader2,
  Lock,
  ChevronDown,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  PhoneNumber,
  PhoneNumberStatus,
  PhoneNumberType,
  PortRequestInput,
  EditNumberPatch,
  fetchPhoneNumbers,
  purchasePhoneNumber,
  requestPortIn,
  updatePhoneNumber,
  setPrimaryPhoneNumber,
  releasePhoneNumber,
  formatPhoneNumber,
  formatCents,
} from '@/lib/phoneNumbers';

// ============================================================
// SHARED UI
// ============================================================

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className}`} />;
}

const STATUS_CONFIG: Record<PhoneNumberStatus, { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-success-500/10 text-success-500' },
  porting_in: { label: 'Porting In', className: 'bg-warning-500/10 text-warning-500' },
  porting_out: { label: 'Porting Out', className: 'bg-warning-500/10 text-warning-500' },
  pending: { label: 'Pending', className: 'bg-accent/10 text-accent' },
  released: { label: 'Released', className: 'bg-bg-tertiary text-text-secondary' },
};

function StatusBadge({ status }: { status: PhoneNumberStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}

const TYPE_LABEL: Record<PhoneNumberType, string> = {
  local: 'Local',
  toll_free: 'Toll-Free',
  mobile: 'Mobile',
};

// ============================================================
// NUMBER CARD
// ============================================================

function NumberCard({
  number,
  onEdit,
  onSetPrimary,
  onRelease,
  onCopy,
}: {
  number: PhoneNumber;
  onEdit: () => void;
  onSetPrimary: () => void;
  onRelease: () => void;
  onCopy: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isReleased = number.status === 'released';

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
            <Phone size={20} />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-bold text-text-primary">{formatPhoneNumber(number.phone_number)}</h3>
              {number.is_primary && (
                <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
                  <Star size={11} className="fill-accent" /> Primary
                </span>
              )}
            </div>
            <p className="mt-0.5 text-sm text-text-secondary">{number.friendly_name}</p>
          </div>
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            aria-label="Number actions"
          >
            <ChevronDown size={16} />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 z-50 mt-2 w-48 rounded-xl border border-border bg-bg-secondary p-1.5 shadow-card-hover dark:shadow-card-hover-dark">
                <button
                  type="button"
                  onClick={() => {
                    onCopy();
                    setMenuOpen(false);
                  }}
                  className="focus-ring flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-tertiary"
                >
                  <Copy size={14} /> Copy number
                </button>
                {!isReleased && (
                  <button
                    type="button"
                    onClick={() => {
                      onEdit();
                      setMenuOpen(false);
                    }}
                    className="focus-ring flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-tertiary"
                  >
                    <Wrench size={14} /> Edit settings
                  </button>
                )}
                {!isReleased && !number.is_primary && (
                  <button
                    type="button"
                    onClick={() => {
                      onSetPrimary();
                      setMenuOpen(false);
                    }}
                    className="focus-ring flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-tertiary"
                  >
                    <Star size={14} /> Set as primary
                  </button>
                )}
                {!isReleased && (
                  <button
                    type="button"
                    onClick={() => {
                      onRelease();
                      setMenuOpen(false);
                    }}
                    className="focus-ring flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-danger/10"
                  >
                    <Trash2 size={14} /> Release number
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <StatusBadge status={number.status} />
        <span className="inline-flex items-center rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
          {TYPE_LABEL[number.number_type]}
        </span>
        {number.voice_enabled && (
          <span className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
            <PhoneCall size={11} /> Voice
          </span>
        )}
        {number.sms_enabled && (
          <span className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
            <MessageSquare size={11} /> SMS
          </span>
        )}
      </div>

      {(number.assigned_trade || number.assigned_location || number.forwarding_number) && (
        <div className="mt-4 space-y-1.5 border-t border-border pt-4 text-sm text-text-secondary">
          {number.assigned_trade && (
            <p className="flex items-center gap-2">
              <Wrench size={13} className="shrink-0 text-text-secondary/70" /> {number.assigned_trade}
            </p>
          )}
          {number.assigned_location && (
            <p className="flex items-center gap-2">
              <MapPin size={13} className="shrink-0 text-text-secondary/70" /> {number.assigned_location}
            </p>
          )}
          {number.forwarding_number && (
            <p className="flex items-center gap-2">
              <PhoneCall size={13} className="shrink-0 text-text-secondary/70" />
              Forwards to {formatPhoneNumber(number.forwarding_number)}
            </p>
          )}
        </div>
      )}

      {number.status === 'porting_in' && (
        <div className="mt-4 rounded-xl border border-warning-500/20 bg-warning-500/5 p-3 text-xs leading-relaxed text-text-secondary">
          Porting typically takes 5–10 business days. We'll notify you the moment this number goes live.
        </div>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
        <span className="text-xs text-text-secondary">
          {number.monthly_cost_cents > 0 ? `${formatCents(number.monthly_cost_cents)}/mo` : 'No monthly fee'}
        </span>
        <span className="text-xs text-text-secondary">
          Added{' '}
          {new Date(number.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      </div>
    </div>
  );
}

// ============================================================
// ADD NUMBER MODAL (Buy new / Port existing)
// ============================================================

const SUGGESTED_AREA_CODES = ['205', '212', '305', '404', '512', '602', '702', '713', '818', '917'];

function AddNumberModal({
  onClose,
  onPurchase,
  onPort,
  submitting,
}: {
  onClose: () => void;
  onPurchase: (phoneNumber: string, friendlyName: string, type: PhoneNumberType) => void;
  onPort: (input: PortRequestInput) => void;
  submitting: boolean;
}) {
  const [tab, setTab] = useState<'buy' | 'port'>('buy');

  // Buy tab state
  const [areaCode, setAreaCode] = useState('');
  const [numberType, setNumberType] = useState<PhoneNumberType>('local');
  const [buyLabel, setBuyLabel] = useState('');
  const [availableNumbers, setAvailableNumbers] = useState<string[]>([]);
  const [selectedNumber, setSelectedNumber] = useState('');
  const [searching, setSearching] = useState(false);

  // Port tab state
  const [portNumber, setPortNumber] = useState('');
  const [portLabel, setPortLabel] = useState('');
  const [carrier, setCarrier] = useState('');
  const [acctLast4, setAcctLast4] = useState('');
  const [zip, setZip] = useState('');
  const [notes, setNotes] = useState('');

  const searchNumbers = (code: string) => {
    if (code.length !== 3) {
      setAvailableNumbers([]);
      return;
    }
    setSearching(true);
    // Simulated search — wire this up to your carrier/provider's number search API.
    setTimeout(() => {
      const generated = Array.from({ length: 6 }, (_, i) => {
        const line = String(1000 + i * 137 + Math.floor(Math.random() * 90)).slice(0, 4);
        return `+1${code}555${line}`;
      });
      setAvailableNumbers(generated);
      setSearching(false);
    }, 500);
  };

  const canSubmitBuy = selectedNumber.length > 0 && buyLabel.trim().length > 0;
  const canSubmitPort =
    portNumber.trim().length >= 10 &&
    portLabel.trim().length > 0 &&
    carrier.trim().length > 0 &&
    acctLast4.trim().length === 4 &&
    zip.trim().length >= 5;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.25 }}
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-base font-bold text-text-primary">Add a Phone Number</h2>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex border-b border-border px-6">
          <button
            type="button"
            onClick={() => setTab('buy')}
            className={`flex items-center gap-2 border-b-2 px-3 py-3 text-sm font-semibold transition-colors ${
              tab === 'buy' ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            <ShoppingCart size={15} /> Buy New
          </button>
          <button
            type="button"
            onClick={() => setTab('port')}
            className={`flex items-center gap-2 border-b-2 px-3 py-3 text-sm font-semibold transition-colors ${
              tab === 'port' ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            <ArrowLeftRight size={15} /> Port Existing
          </button>
        </div>

        <div className="max-h-[65vh] overflow-y-auto px-6 py-5">
          {tab === 'buy' ? (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-text-secondary">Area code</label>
                <div className="mt-1.5 flex gap-2">
                  <input
                    type="text"
                    maxLength={3}
                    value={areaCode}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, '');
                      setAreaCode(v);
                      if (v.length === 3) searchNumbers(v);
                      else setAvailableNumbers([]);
                    }}
                    placeholder="e.g. 512"
                    className="focus-ring w-28 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                  />
                  <select
                    value={numberType}
                    onChange={(e) => setNumberType(e.target.value as PhoneNumberType)}
                    className="focus-ring flex-1 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                  >
                    <option value="local">Local</option>
                    <option value="toll_free">Toll-Free</option>
                  </select>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {SUGGESTED_AREA_CODES.map((code) => (
                    <button
                      key={code}
                      type="button"
                      onClick={() => {
                        setAreaCode(code);
                        searchNumbers(code);
                      }}
                      className="rounded-full border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:border-accent/40 hover:text-text-primary"
                    >
                      {code}
                    </button>
                  ))}
                </div>
              </div>

              {searching && (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-text-secondary">
                  <Loader2 size={16} className="animate-spin" /> Searching available numbers…
                </div>
              )}

              {!searching && availableNumbers.length > 0 && (
                <div className="grid gap-2">
                  {availableNumbers.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setSelectedNumber(n)}
                      className={`focus-ring flex items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                        selectedNumber === n
                          ? 'border-accent bg-accent/5 text-accent'
                          : 'border-border text-text-primary hover:border-accent/40'
                      }`}
                    >
                      {formatPhoneNumber(n)}
                      {selectedNumber === n && <Check size={16} />}
                    </button>
                  ))}
                </div>
              )}

              <div>
                <label className="text-xs font-medium text-text-secondary">Label</label>
                <input
                  type="text"
                  value={buyLabel}
                  onChange={(e) => setBuyLabel(e.target.value)}
                  placeholder="e.g. Main Line, Emergency Line"
                  className="focus-ring mt-1.5 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-text-secondary">Phone number to port</label>
                <input
                  type="tel"
                  value={portNumber}
                  onChange={(e) => setPortNumber(e.target.value)}
                  placeholder="+1 (555) 123-4567"
                  className="focus-ring mt-1.5 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary">Label</label>
                <input
                  type="text"
                  value={portLabel}
                  onChange={(e) => setPortLabel(e.target.value)}
                  placeholder="e.g. Main Line"
                  className="focus-ring mt-1.5 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-text-secondary">Current carrier</label>
                  <input
                    type="text"
                    value={carrier}
                    onChange={(e) => setCarrier(e.target.value)}
                    placeholder="e.g. AT&T"
                    className="focus-ring mt-1.5 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-text-secondary">Account # (last 4)</label>
                  <input
                    type="text"
                    maxLength={4}
                    value={acctLast4}
                    onChange={(e) => setAcctLast4(e.target.value.replace(/\D/g, ''))}
                    placeholder="1234"
                    className="focus-ring mt-1.5 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary">Billing ZIP code</label>
                <input
                  type="text"
                  value={zip}
                  onChange={(e) => setZip(e.target.value)}
                  placeholder="90210"
                  className="focus-ring mt-1.5 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary">Notes (optional)</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  className="focus-ring mt-1.5 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                />
              </div>
              <p className="text-xs leading-relaxed text-text-secondary">
                Porting a number keeps it active with your current carrier until the transfer completes —
                typically 5–10 business days. No service interruption.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="focus-ring rounded-xl px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          {tab === 'buy' ? (
            <button
              type="button"
              disabled={!canSubmitBuy || submitting}
              onClick={() => onPurchase(selectedNumber, buyLabel.trim(), numberType)}
              className="focus-ring flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              Add Number
            </button>
          ) : (
            <button
              type="button"
              disabled={!canSubmitPort || submitting}
              onClick={() =>
                onPort({
                  phone_number: portNumber.trim(),
                  friendly_name: portLabel.trim(),
                  losing_carrier: carrier.trim(),
                  account_number_last4: acctLast4.trim(),
                  billing_zip: zip.trim(),
                  notes: notes.trim() || undefined,
                })
              }
              className="focus-ring flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              Start Port Request
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// ============================================================
// EDIT NUMBER DRAWER
// ============================================================

function EditNumberDrawer({
  number,
  onClose,
  onSave,
  submitting,
}: {
  number: PhoneNumber;
  onClose: () => void;
  onSave: (patch: EditNumberPatch) => void;
  submitting: boolean;
}) {
  const [friendlyName, setFriendlyName] = useState(number.friendly_name);
  const [forwarding, setForwarding] = useState(number.forwarding_number ?? '');
  const [trade, setTrade] = useState(number.assigned_trade ?? '');
  const [location, setLocation] = useState(number.assigned_location ?? '');
  const [voiceEnabled, setVoiceEnabled] = useState(number.voice_enabled);
  const [smsEnabled, setSmsEnabled] = useState(number.sms_enabled);

  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ x: 24, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.25 }}
        className="relative flex h-full w-full max-w-md flex-col border-l border-border bg-bg-secondary"
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-base font-bold text-text-primary">{formatPhoneNumber(number.phone_number)}</h2>
            <p className="text-xs text-text-secondary">Edit number settings</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div>
            <label className="text-xs font-medium text-text-secondary">Label</label>
            <input
              type="text"
              value={friendlyName}
              onChange={(e) => setFriendlyName(e.target.value)}
              className="focus-ring mt-1.5 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-text-secondary">Forwarding number</label>
            <input
              type="tel"
              value={forwarding}
              onChange={(e) => setForwarding(e.target.value)}
              placeholder="Optional fallback number"
              className="focus-ring mt-1.5 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
            />
            <p className="mt-1.5 text-xs text-text-secondary">Sarah will offer to connect here if a caller asks for a human.</p>
          </div>
          <div>
            <label className="text-xs font-medium text-text-secondary">Assigned trade</label>
            <input
              type="text"
              value={trade}
              onChange={(e) => setTrade(e.target.value)}
              placeholder="e.g. HVAC, Plumbing"
              className="focus-ring mt-1.5 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-text-secondary">Assigned location</label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Austin Branch"
              className="focus-ring mt-1.5 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
            />
          </div>
          <div className="space-y-3 border-t border-border pt-4">
            <label className="flex items-center justify-between text-sm text-text-primary">
              Voice calls
              <input
                type="checkbox"
                checked={voiceEnabled}
                onChange={(e) => setVoiceEnabled(e.target.checked)}
                className="accent-accent"
              />
            </label>
            <label className="flex items-center justify-between text-sm text-text-primary">
              SMS messaging
              <input
                type="checkbox"
                checked={smsEnabled}
                onChange={(e) => setSmsEnabled(e.target.checked)}
                className="accent-accent"
              />
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="focus-ring rounded-xl px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting || friendlyName.trim().length === 0}
            onClick={() =>
              onSave({
                friendly_name: friendlyName.trim(),
                forwarding_number: forwarding.trim() || null,
                assigned_trade: trade.trim() || null,
                assigned_location: location.trim() || null,
                voice_enabled: voiceEnabled,
                sms_enabled: smsEnabled,
              })
            }
            className="focus-ring flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            Save Changes
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ============================================================
// RELEASE CONFIRM MODAL
// ============================================================

function ReleaseConfirmModal({
  number,
  onClose,
  onConfirm,
  submitting,
}: {
  number: PhoneNumber;
  onClose: () => void;
  onConfirm: () => void;
  submitting: boolean;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2 }}
        className="relative w-full max-w-sm rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover dark:shadow-card-hover-dark"
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-danger/10 text-danger">
          <Trash2 size={20} />
        </span>
        <h2 className="mt-4 text-base font-bold text-text-primary">Release this number?</h2>
        <p className="mt-2 text-sm leading-relaxed text-text-secondary">
          {formatPhoneNumber(number.phone_number)} will stop receiving calls immediately. This can't be
          undone — releasing a number does not guarantee you can reclaim it later.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="focus-ring rounded-xl px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={onConfirm}
            className="focus-ring flex items-center gap-2 rounded-xl bg-danger px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            Release Number
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================

export function PhoneNumbersPage() {
  const navigate = useNavigate();
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canAccess = isOwner || permissions.can_manage_numbers;

  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<PhoneNumberStatus | 'all'>('all');

  const [showAddModal, setShowAddModal] = useState(false);
  const [editTarget, setEditTarget] = useState<PhoneNumber | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<PhoneNumber | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadNumbers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchPhoneNumbers();
      setNumbers(data);
    } catch {
      toast('Could not load phone numbers.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadNumbers();
  }, [loadNumbers]);

  const filtered = useMemo(() => {
    return numbers.filter((n) => {
      if (statusFilter !== 'all' && n.status !== statusFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const haystack = `${n.phone_number} ${n.friendly_name} ${n.assigned_trade ?? ''} ${n.assigned_location ?? ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [numbers, search, statusFilter]);

  const kpis = useMemo(() => {
    const active = numbers.filter((n) => n.status === 'active').length;
    const porting = numbers.filter((n) => n.status === 'porting_in' || n.status === 'porting_out').length;
    const monthlyCost = numbers.filter((n) => n.status !== 'released').reduce((sum, n) => sum + n.monthly_cost_cents, 0);
    return { total: numbers.length, active, porting, monthlyCost };
  }, [numbers]);

  const handlePurchase = async (phoneNumber: string, friendlyName: string, numberType: PhoneNumberType) => {
    setSubmitting(true);
    try {
      await purchasePhoneNumber(phoneNumber, { friendly_name: friendlyName, number_type: numberType });
      toast('Number added.', 'success');
      setShowAddModal(false);
      loadNumbers();
    } catch {
      toast('Could not add that number. Try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePort = async (input: PortRequestInput) => {
    setSubmitting(true);
    try {
      await requestPortIn(input);
      toast("Port request submitted. We'll notify you once it completes.", 'success');
      setShowAddModal(false);
      loadNumbers();
    } catch {
      toast('Could not submit the port request. Try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveEdit = async (patch: EditNumberPatch) => {
    if (!editTarget) return;
    setSubmitting(true);
    try {
      await updatePhoneNumber(editTarget.id, patch);
      toast('Number updated.', 'success');
      setEditTarget(null);
      loadNumbers();
    } catch {
      toast('Could not save changes.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetPrimary = async (number: PhoneNumber) => {
    try {
      await setPrimaryPhoneNumber(number.id, number.account_id);
      toast(`${formatPhoneNumber(number.phone_number)} is now your primary number.`, 'success');
      loadNumbers();
    } catch {
      toast('Could not update primary number.', 'error');
    }
  };

  const handleRelease = async () => {
    if (!releaseTarget) return;
    setSubmitting(true);
    try {
      await releasePhoneNumber(releaseTarget.id);
      toast('Number released.', 'success');
      setReleaseTarget(null);
      loadNumbers();
    } catch {
      toast('Could not release this number.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = (number: PhoneNumber) => {
    navigator.clipboard.writeText(formatPhoneNumber(number.phone_number));
    toast('Number copied.', 'success');
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Phone Numbers">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Number management is restricted. Ask your account owner to grant you access.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Phone Numbers">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Phone Numbers</h1>
            <p className="mt-1 text-sm text-text-secondary">Manage the numbers Sarah answers on your behalf.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="focus-ring flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          <Plus size={16} /> Add Number
        </button>
      </div>

      {/* KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <SkeletonBlock className="h-4 w-24" />
              <SkeletonBlock className="mt-3 h-8 w-16" />
            </div>
          ))
        ) : (
          <>
            <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <p className="text-xs font-medium text-text-secondary">Total Numbers</p>
              <p className="mt-2 text-3xl font-bold text-text-primary">{kpis.total}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <p className="text-xs font-medium text-text-secondary">Active</p>
              <p className="mt-2 text-3xl font-bold text-success-500">{kpis.active}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <p className="text-xs font-medium text-text-secondary">Porting</p>
              <p className="mt-2 text-3xl font-bold text-warning-500">{kpis.porting}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <p className="text-xs font-medium text-text-secondary">Monthly Cost</p>
              <p className="mt-2 text-3xl font-bold text-cta">{formatCents(kpis.monthlyCost)}</p>
            </div>
          </>
        )}
      </div>

      {/* Toolbar */}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 sm:max-w-sm">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by number, label, trade, location…"
            className="focus-ring w-full rounded-xl border border-border bg-bg-secondary py-2.5 pl-9 pr-3 text-sm text-text-primary"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {(['all', 'active', 'porting_in', 'pending', 'released'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                statusFilter === s
                  ? 'border-accent bg-accent text-white'
                  : 'border-border bg-bg-secondary text-text-secondary hover:border-accent/40 hover:text-text-primary'
              }`}
            >
              {s === 'all' ? 'All' : STATUS_CONFIG[s]?.label ?? s}
            </button>
          ))}
        </div>
      </div>

      {/* Number list */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <SkeletonBlock className="h-11 w-11 rounded-xl" />
              <SkeletonBlock className="mt-4 h-4 w-32" />
              <SkeletonBlock className="mt-2 h-3 w-24" />
            </div>
          ))
        ) : filtered.length === 0 ? (
          <div className="col-span-full flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
              <Phone size={22} />
            </span>
            <h3 className="mt-4 text-base font-semibold text-text-primary">
              {numbers.length === 0 ? 'No phone numbers yet' : 'No numbers match your filters'}
            </h3>
            <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
              {numbers.length === 0
                ? 'Buy a new number or port your existing one so Sarah can start answering calls.'
                : 'Try a different search term or status filter.'}
            </p>
            {numbers.length === 0 && (
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="focus-ring mt-5 flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                <Plus size={16} /> Add Number
              </button>
            )}
          </div>
        ) : (
          <AnimatePresence>
            {filtered.map((number) => (
              <motion.div key={number.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <NumberCard
                  number={number}
                  onEdit={() => setEditTarget(number)}
                  onSetPrimary={() => handleSetPrimary(number)}
                  onRelease={() => setReleaseTarget(number)}
                  onCopy={() => handleCopy(number)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>

      {showAddModal && (
        <AddNumberModal onClose={() => setShowAddModal(false)} onPurchase={handlePurchase} onPort={handlePort} submitting={submitting} />
      )}

      {editTarget && (
        <EditNumberDrawer number={editTarget} onClose={() => setEditTarget(null)} onSave={handleSaveEdit} submitting={submitting} />
      )}

      {releaseTarget && (
        <ReleaseConfirmModal number={releaseTarget} onClose={() => setReleaseTarget(null)} onConfirm={handleRelease} submitting={submitting} />
      )}
    </DashboardLayout>
  );
}
