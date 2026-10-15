import { useEffect, useState } from 'react';
import { CheckCircle2, FlaskConical, Loader2, ShieldAlert } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import {
  addEntry,
  createOverride,
  evaluateBlock,
  fetchOwnedNumbers,
  fetchTesterContext,
  formatPhone,
  toE164,
  type BlockDecision,
} from '@/lib/callBlocklist';

const SELECT_CLASS = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary';

interface NumberTesterProps {
  ownerId: string;
  userId: string;
  onChanged: () => void;
}

/** Runs the SAME engine the live call path uses, against the account's real rules, list, overrides and call history. */
export function NumberTester({ ownerId, userId, onChanged }: NumberTesterProps) {
  const { toast } = useToast();
  const [phone, setPhone] = useState('');
  const [hidden, setHidden] = useState(false);
  const [owned, setOwned] = useState<string[]>([]);
  const [dialed, setDialed] = useState('');
  const [testing, setTesting] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ decision: BlockDecision; phone: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchOwnedNumbers(ownerId)
      .then((n) => {
        if (cancelled) return;
        setOwned(n);
        setDialed((d) => d || n[0] || '');
      })
      .catch(() => undefined); // optional input — only needed for neighbor-spoof checks
    return () => {
      cancelled = true;
    };
  }, [ownerId]);

  const runTest = async () => {
    setError('');
    setResult(null);
    const e164 = hidden ? null : toE164(phone);
    if (!hidden && !e164) {
      setError('Enter a valid phone number, or tick “Caller ID hidden”.');
      return;
    }
    setTesting(true);
    try {
      const { ctx, recentCalls } = await fetchTesterContext(ownerId, e164);
      const decision = evaluateBlock({ callerNumber: e164, dialedNumber: dialed || null, now: new Date(), recentCalls }, ctx);
      setResult({ decision, phone: e164 });
    } catch {
      setError('Could not run the test. Please try again.');
    } finally {
      setTesting(false);
    }
  };

  const act = async (kind: 'override' | 'block') => {
    if (!result?.phone) return;
    setActing(true);
    try {
      if (kind === 'override') {
        await createOverride(ownerId, userId, { phone: result.phone, hours: 24, uses: 1, note: 'Created from the number tester' });
        toast('One-time override created for 24 hours.', 'success');
      } else {
        await addEntry('blocklist', ownerId, userId, result.phone, 'spam', '');
        toast('Number blocked.', 'success');
      }
      onChanged();
      await runTest();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That did not work. Please try again.', 'error');
    } finally {
      setActing(false);
    }
  };

  const d = result?.decision;
  return (
    <Card className="space-y-4 p-5 hover:translate-y-0">
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent"><FlaskConical size={16} /></span>
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Test a number</h2>
          <p className="text-xs text-text-secondary">See exactly what happens when this caller rings you. Nothing is dialed.</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Caller number" type="tel" inputMode="tel" value={phone} disabled={hidden} onChange={(e) => setPhone(e.target.value)} placeholder="(512) 555-0123" error={error || undefined} />
        <div>
          <label htmlFor="tester-dialed" className="mb-1 block text-xs font-medium text-text-secondary">They dial</label>
          {owned.length > 0 ? (
            <select id="tester-dialed" className={SELECT_CLASS} value={dialed} onChange={(e) => setDialed(e.target.value)}>
              {owned.map((n) => (
                <option key={n} value={n}>{formatPhone(n)}</option>
              ))}
            </select>
          ) : (
            <p className="rounded-xl bg-bg-tertiary px-3 py-2.5 text-xs text-text-secondary">Add a business number to test neighbor-spoof detection.</p>
          )}
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" className="focus-ring h-4 w-4 rounded border-border" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
        Caller ID hidden
      </label>
      <Button type="button" size="sm" onClick={() => void runTest()} disabled={testing || (!hidden && !phone.trim())}>
        {testing && <Loader2 size={14} className="animate-spin" />} Test
      </Button>

      {d && (
        <div role="status" aria-live="polite" className={`space-y-3 rounded-xl p-4 ${d.blocked ? 'bg-danger/10' : 'bg-success-500/10'}`}>
          <div className="flex items-start gap-3">
            {d.blocked ? <ShieldAlert size={20} className="mt-0.5 shrink-0 text-danger" /> : <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-success-500" />}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">{d.blocked ? 'This call would be blocked' : d.reason === 'override' ? 'This call would be let through by an override' : 'This call would be answered'}</p>
              <p className="text-xs text-text-secondary">{d.detail}</p>
            </div>
          </div>
          {result?.phone && (
            <div className="flex flex-wrap gap-2">
              {d.blocked && <Button type="button" variant="secondary" size="sm" onClick={() => void act('override')} disabled={acting}>Let the next call through</Button>}
              {!d.blocked && d.reason !== 'override' && <Button type="button" variant="secondary" size="sm" onClick={() => void act('block')} disabled={acting}>Block this number</Button>}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
