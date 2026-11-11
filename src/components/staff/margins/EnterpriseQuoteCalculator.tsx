import { useMemo, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { formatUsd } from '@/lib/staffUsage';
import {
  DEFAULT_ENTERPRISE_RATES,
  MARGIN_WARNING_THRESHOLD,
  isBelowMarginWarning,
  quoteEnterprise,
  type EnterpriseQuoteResult,
} from '@/lib/enterpriseQuote';
import { Field, INPUT, Section, TD, TDR, TableWrap, TH, THR } from './shared';

/** Strict non-negative decimal; blank or anything else (NaN, 1e999, "12abc", "-1") is invalid. */
const NUM = /^\d+(\.\d+)?$/;
const num = (s: string): number | null => {
  const t = s.trim();
  if (!NUM.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const cents = (c: number) => formatUsd(c / 100);

type Result = { value: EnterpriseQuoteResult } | { error: string };

/** Staff-only. Rendered inside the staff-guarded /staff/margins page; pure estimate, never changes prices. */
export function EnterpriseQuoteCalculator({ measuredCostPerMinute = null }: { measuredCostPerMinute?: number | null }) {
  const [minutes, setMinutes] = useState('6000');
  const [seats, setSeats] = useState('50');
  const [locations, setLocations] = useState('3');
  const [phones, setPhones] = useState('3');
  const [sms, setSms] = useState('0');
  const [support, setSupport] = useState('0');
  const [discountPct, setDiscountPct] = useState('0');
  const [voiceCpm, setVoiceCpm] = useState(String(DEFAULT_ENTERPRISE_RATES.voiceCostPerMinute));
  const [fixedAlloc, setFixedAlloc] = useState(String(DEFAULT_ENTERPRISE_RATES.nonVoiceBase));
  const [targetPct, setTargetPct] = useState(String(DEFAULT_ENTERPRISE_RATES.targetGrossMargin * 100));

  const result: Result = useMemo(() => {
    const v = {
      committedMinutes: num(minutes), seats: num(seats), locations: num(locations), phoneNumbers: num(phones),
      smsPerMonth: num(sms), supportMonthly: num(support), discountPct: num(discountPct),
      voice: num(voiceCpm), fixed: num(fixedAlloc), target: num(targetPct),
    };
    if (Object.values(v).some((x) => x === null)) return { error: 'Enter a valid non-negative number in every field.' };
    try {
      return {
        value: quoteEnterprise(
          {
            committedMinutes: v.committedMinutes!, seats: v.seats!, locations: v.locations!, phoneNumbers: v.phoneNumbers!,
            smsPerMonth: v.smsPerMonth!, supportMonthly: v.supportMonthly!, discount: v.discountPct! / 100, fixedAllocation: v.fixed!,
          },
          { voiceCostPerMinute: v.voice!, targetGrossMargin: v.target! / 100 },
        ),
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Invalid input' };
    }
  }, [minutes, seats, locations, phones, sms, support, discountPct, voiceCpm, fixedAlloc, targetPct]);

  const q = 'value' in result ? result.value : null;
  const warn = q !== null && isBelowMarginWarning(q);
  const marginText = q ? `${(q.grossMarginAtFullUse * 100).toFixed(1)}%` : '—';

  return (
    <Section title="Enterprise quote calculator (staff only)">
      <p className="mb-3 text-sm text-text-secondary">Cost-plus floor with a $1,799 minimum list price. An <strong>estimate</strong> from the inputs below; it recommends, it never changes prices.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Committed minutes / month"><input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} className={INPUT} /></Field>
        <Field label="Seats"><input inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} className={INPUT} /></Field>
        <Field label="Locations"><input inputMode="numeric" value={locations} onChange={(e) => setLocations(e.target.value)} className={INPUT} /></Field>
        <Field label="Phone numbers"><input inputMode="numeric" value={phones} onChange={(e) => setPhones(e.target.value)} className={INPUT} /></Field>
        <Field label="SMS / month"><input inputMode="numeric" value={sms} onChange={(e) => setSms(e.target.value)} className={INPUT} /></Field>
        <Field label="Support cost / month (USD)"><input inputMode="decimal" value={support} onChange={(e) => setSupport(e.target.value)} className={INPUT} /></Field>
        <Field label="Discount %" hint="applied to the list price"><input inputMode="decimal" value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} className={INPUT} /></Field>
      </div>
      <details className="mt-3">
        <summary className="focus-ring cursor-pointer text-sm font-medium text-text-primary">Cost assumptions</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Voice cost $/min" hint={measuredCostPerMinute === null ? undefined : `measured this window: ${formatUsd(measuredCostPerMinute)}/min (reference only)`}><input inputMode="decimal" value={voiceCpm} onChange={(e) => setVoiceCpm(e.target.value)} className={INPUT} /></Field>
          <Field label="Fixed allocation / month (USD)"><input inputMode="decimal" value={fixedAlloc} onChange={(e) => setFixedAlloc(e.target.value)} className={INPUT} /></Field>
          <Field label="Target gross margin %"><input inputMode="decimal" value={targetPct} onChange={(e) => setTargetPct(e.target.value)} className={INPUT} /></Field>
        </div>
      </details>
      <div className="mt-4" role="status" aria-live="polite">
        {'error' in result ? <p className="text-sm text-text-secondary">{result.error}</p> : q && (
          <div className="space-y-3">
            {warn && (
              <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm font-medium text-text-primary">
                <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
                <span>Warning: this price yields {marginText} gross margin at full use, below the {Math.round(MARGIN_WARNING_THRESHOLD * 100)}% minimum. Raise the price or reduce the discount before quoting.</span>
              </p>
            )}
            <TableWrap caption="Enterprise quote">
              <thead><tr><th scope="col" className={TH}>Item</th><th scope="col" className={THR}>Amount</th></tr></thead>
              <tbody>
                <tr className="border-t border-border"><th scope="row" className={`${TD} font-medium`}>Monthly price floor (cost-plus)</th><td className={TDR}>{cents(q.monthlyFloorCents)}</td></tr>
                <tr className="border-t border-border"><th scope="row" className={`${TD} font-medium`}>List price / month</th><td className={TDR}>{cents(q.listPriceCents)}</td></tr>
                <tr className="border-t border-border"><th scope="row" className={`${TD} font-medium`}>Overage / minute</th><td className={TDR}>{q.overageCentsPerMinute}¢ per minute</td></tr>
                <tr className="border-t border-border"><th scope="row" className={`${TD} font-medium`}>Onboarding (one-time)</th><td className={TDR}>{cents(q.onboardingCents)}</td></tr>
                <tr className="border-t border-border"><th scope="row" className={`${TD} font-medium`}>Annual contract</th><td className={TDR}>{cents(q.annualContractCents)}</td></tr>
                <tr className="border-t border-border"><th scope="row" className={`${TD} font-medium`}>Gross margin at full use</th><td className={TDR}>{marginText}{warn ? ' (below target)' : ''}</td></tr>
              </tbody>
            </TableWrap>
          </div>
        )}
      </div>
    </Section>
  );
}
