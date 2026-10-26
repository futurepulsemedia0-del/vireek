import { useMemo, useState } from 'react';
import { Check, Copy, FolderLock, Loader2, ShieldOff } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { DATA_ROOM_SECTIONS, linkState, validateShare, type LinkState } from '@/lib/exitReadiness';
import type { AccessLogEntry, DataRoomLink } from '@/lib/exitReadinessApi';
import { EstimateBanner, Toggle, selectClass } from './shared';

interface Props {
  links: DataRoomLink[];
  logs: AccessLogEntry[];
  creating: boolean;
  /** The just-created URL. Shown once; it cannot be recovered later. */
  createdUrl: string | null;
  onCreate: (input: { label: string; sections: string[]; recipient: string; expiresHours: number; maxViews: number; includeNames: boolean }) => Promise<void>;
  onRevoke: (link: DataRoomLink) => void;
  onDismissUrl: () => void;
}

const STATE_STYLE: Record<LinkState, string> = {
  active: 'bg-success-500/10 text-success-500',
  expired: 'bg-bg-tertiary text-text-secondary',
  revoked: 'bg-danger/10 text-danger',
  exhausted: 'bg-warning-500/10 text-warning-500',
};
const OUTCOME_LABEL: Record<AccessLogEntry['outcome'], string> = {
  granted: 'Viewed', expired: 'Blocked — expired', revoked: 'Blocked — revoked', exhausted: 'Blocked — view limit', invalid_token: 'Invalid link',
};
const EXPIRY_OPTIONS = [
  { hours: 24, label: '24 hours' }, { hours: 72, label: '3 days' }, { hours: 168, label: '7 days' },
  { hours: 336, label: '14 days' }, { hours: 720, label: '30 days' },
];

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function DataRoomPanel({ links, logs, creating, createdUrl, onCreate, onRevoke, onDismissUrl }: Props) {
  const [label, setLabel] = useState('');
  const [recipient, setRecipient] = useState('');
  const [expiresHours, setExpiresHours] = useState(168);
  const [maxViews, setMaxViews] = useState('10');
  const [includeNames, setIncludeNames] = useState(false);
  const [sections, setSections] = useState<string[]>(['financials', 'kpis', 'valuation']);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [openLog, setOpenLog] = useState<string | null>(null);

  const labelById = useMemo(() => new Map(links.map((l) => [l.id, l.label])), [links]);
  const toggleSection = (key: string, on: boolean) => setSections((s) => (on ? [...new Set([...s, key])] : s.filter((x) => x !== key)));

  const submit = async () => {
    const draft = { label, recipient, expiresHours, maxViews: Number(maxViews), sections };
    const found = validateShare(draft);
    setErrors(found);
    if (Object.keys(found).length) return;
    await onCreate({ ...draft, includeNames });
    setLabel('');
    setRecipient('');
  };

  const copy = async () => {
    if (!createdUrl) return;
    try {
      await navigator.clipboard.writeText(createdUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const shownLogs = openLog ? logs.filter((l) => l.linkId === openLog) : logs;

  return (
    <div className="space-y-6">
      <EstimateBanner compact />

      {createdUrl && (
        <Card className="!border-success-500/40">
          <h2 className="text-sm font-semibold text-text-primary">Your link is ready — copy it now</h2>
          <p className="mt-1 text-xs text-text-secondary">For security the full link is shown only once. Anyone with it can open the shared sections until it expires or you revoke it.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-primary">{createdUrl}</code>
            <Button variant="secondary" size="sm" onClick={() => void copy()}>{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} {copied ? 'Copied' : 'Copy'}</Button>
            <Button variant="ghost" size="sm" onClick={onDismissUrl}>Done</Button>
          </div>
        </Card>
      )}

      <Card>
        <h2 className="mb-1 text-lg font-semibold text-text-primary">Create a buyer data room</h2>
        <p className="mb-4 text-xs text-text-secondary">A read-only snapshot is frozen when you create it. Customer names and contact details are never included, and staff are shown as “Technician 1…” unless you opt in.</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input id="dr-label" label="Data room name" value={label} onChange={(e) => setLabel(e.target.value)} error={errors.label} maxLength={120} placeholder="e.g. Buyer A — first look" />
          <Input id="dr-recipient" label="Recipient (optional)" value={recipient} onChange={(e) => setRecipient(e.target.value)} error={errors.recipient} maxLength={120} helperText="Only for your own log; not sent anywhere." />
          <div>
            <label htmlFor="dr-expiry" className="mb-1.5 block text-sm font-medium text-text-primary">Link expires after</label>
            <select id="dr-expiry" className={selectClass} value={expiresHours} onChange={(e) => setExpiresHours(Number(e.target.value))}>
              {EXPIRY_OPTIONS.map((o) => <option key={o.hours} value={o.hours}>{o.label}</option>)}
            </select>
            {errors.expiresHours && <p className="mt-1 text-xs text-danger">{errors.expiresHours}</p>}
          </div>
          <Input id="dr-views" label="Maximum views" type="number" inputMode="numeric" min={1} max={1000} value={maxViews} onChange={(e) => setMaxViews(e.target.value)} error={errors.maxViews} />
        </div>
        <fieldset className="mt-4">
          <legend className="mb-2 text-sm font-medium text-text-primary">Sections to share</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {DATA_ROOM_SECTIONS.map((s) => <Toggle key={s.key} id={`dr-sec-${s.key}`} checked={sections.includes(s.key)} onChange={(on) => toggleSection(s.key, on)} label={s.label} hint={s.hint} />)}
          </div>
          {errors.sections && <p className="mt-1 text-xs text-danger">{errors.sections}</p>}
        </fieldset>
        {sections.includes('credentials') && (
          <div className="mt-3"><Toggle id="dr-names" checked={includeNames} onChange={setIncludeNames} label="Show technician names on licences and policies" hint="Off by default — staff appear as Technician 1, 2, …" /></div>
        )}
        <div className="mt-5">
          <Button variant="primary" size="sm" disabled={creating} onClick={() => void submit()}>
            {creating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <FolderLock size={14} aria-hidden="true" />} Create secure link
          </Button>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-lg font-semibold text-text-primary">Links</h2>
        {links.length === 0 ? (
          <EmptyState icon={FolderLock} title="No data rooms yet" description="Create one above when you are ready to share with a buyer, broker or lender." />
        ) : (
          <ul className="divide-y divide-border/60">
            {links.map((l) => {
              const st = linkState(l);
              return (
                <li key={l.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">{l.label} <span className="text-xs font-normal text-text-secondary">· …{l.tokenHint}</span></p>
                    <p className="text-[11px] text-text-secondary">
                      {l.recipientLabel ? `${l.recipientLabel} · ` : ''}{l.viewCount}/{l.maxViews} views · expires {when(l.expiresAt)} · {l.sections.length} sections
                    </p>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATE_STYLE[st]}`}>{st.charAt(0).toUpperCase() + st.slice(1)}</span>
                  <Button variant="ghost" size="sm" onClick={() => setOpenLog(openLog === l.id ? null : l.id)}>{openLog === l.id ? 'All activity' : 'Activity'}</Button>
                  {st === 'active' && <Button variant="ghost" size="sm" onClick={() => onRevoke(l)}><ShieldOff size={14} aria-hidden="true" /> Revoke</Button>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-lg font-semibold text-text-primary">Access log</h2>
        {shownLogs.length === 0 ? (
          <EmptyState icon={FolderLock} title="No access yet" description="Every open and every blocked attempt is recorded here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Data room access log</caption>
              <thead className="text-xs text-text-secondary"><tr><th scope="col" className="py-2 pr-4">When</th><th scope="col" className="py-2 pr-4">Result</th><th scope="col" className="py-2 pr-4">Data room</th><th scope="col" className="py-2">Browser</th></tr></thead>
              <tbody>
                {shownLogs.map((g) => (
                  <tr key={g.id} className="border-t border-border/60">
                    <td className="whitespace-nowrap py-2 pr-4 text-text-secondary">{when(g.accessedAt)}</td>
                    <td className={`py-2 pr-4 ${g.outcome === 'granted' ? 'text-text-primary' : 'text-warning-500'}`}>{OUTCOME_LABEL[g.outcome]}</td>
                    <td className="py-2 pr-4 text-text-secondary">{g.linkId ? labelById.get(g.linkId) ?? 'Data room' : '—'}</td>
                    <td className="max-w-[240px] truncate py-2 text-text-secondary" title={g.userAgent ?? ''}>{g.userAgent || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
