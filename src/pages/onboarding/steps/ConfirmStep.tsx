import type { ReactNode } from 'react';
import { Building2, CalendarDays, ClipboardCheck, Clock, Phone, Sparkles, Wrench } from 'lucide-react';
import { StepShell } from '../StepShell';
import {
  DAYS_OF_WEEK,
  DAY_LABELS,
  INDUSTRY_OPTIONS,
  TEAM_SIZE_OPTIONS,
  EMERGENCY_HANDLING_OPTIONS,
  CALENDAR_PROVIDER_OPTIONS,
  type StepProps,
} from '../types';

function SummaryCard({ icon: Icon, label, children }: { icon: typeof Building2; label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="flex items-center gap-2">
        <Icon size={14} className="text-accent" />
        <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">{label}</span>
      </div>
      <div className="mt-1.5 space-y-0.5 text-xs text-text-secondary">{children}</div>
    </div>
  );
}

export function ConfirmStep({ data, onBack, onNext, saving }: StepProps) {
  return (
    <StepShell
      stepKey="confirm"
      icon={ClipboardCheck}
      title="Let's double-check everything"
      description="Here's what Sarah knows so far. You can refine everything from your dashboard settings."
      onBack={onBack}
      onNext={onNext}
      nextLabel="Looks good"
      saving={saving}
    >
      <div className="space-y-3">
        <SummaryCard icon={Building2} label="Business">
          <p className="text-sm font-medium text-text-primary">
            {data.companyName || 'Not set'} — {data.fullName || 'Not set'}
          </p>
          {data.services.length > 0 && <p>Services: {data.services.join(', ')}</p>}
          {data.serviceArea && <p>Area: {data.serviceArea}</p>}
        </SummaryCard>

        {(data.primaryIndustry || data.teamSize || data.handlesEmergencyCalls || data.avgJobValue) && (
          <SummaryCard icon={Wrench} label="Operations">
            {data.primaryIndustry && <p>Industry: {INDUSTRY_OPTIONS.find((o) => o.value === data.primaryIndustry)?.label}</p>}
            {data.teamSize && <p>Team size: {TEAM_SIZE_OPTIONS.find((o) => o.value === data.teamSize)?.label}</p>}
            {data.avgJobValue && <p>Average job value: ${data.avgJobValue}</p>}
            {data.handlesEmergencyCalls && (
              <p>Emergency calls: {EMERGENCY_HANDLING_OPTIONS.find((o) => o.value === data.handlesEmergencyCalls)?.label}</p>
            )}
          </SummaryCard>
        )}

        <SummaryCard icon={Clock} label="Hours">
          {Object.keys(data.hours).length > 0 ? (
            DAYS_OF_WEEK.filter((d) => data.hours[d]).map((day) => (
              <p key={day}>
                {DAY_LABELS[day]}: {data.hours[day].open} – {data.hours[day].close}
              </p>
            ))
          ) : (
            <p>Hours not set — Sarah will offer to take a message any time.</p>
          )}
        </SummaryCard>

        <SummaryCard icon={Phone} label="Phone">
          {data.phoneChoice === 'new_number' && data.newPhoneNumber && <p>New number: {data.newPhoneNumber} ({data.newPhoneFriendlyName})</p>}
          {data.phoneChoice === 'existing_number' && <p>Forwarding: {data.forwardingNumber || data.phone || 'Not set'}</p>}
          {data.phoneChoice === 'skip' && <p>Skipped — set this up later from Phone Numbers.</p>}
        </SummaryCard>

        <SummaryCard icon={CalendarDays} label="Calendar">
          <p>{CALENDAR_PROVIDER_OPTIONS.find((o) => o.value === data.calendarProvider)?.label}</p>
        </SummaryCard>

        <SummaryCard icon={Sparkles} label="Sarah">
          <p>
            {data.assistantName || 'Sarah'} · {data.assistantVoice.replace('_', ' ')} · {data.assistantTone}
          </p>
          {data.faqs.length > 0 && <p>{data.faqs.length} knowledge base answer{data.faqs.length === 1 ? '' : 's'} ready to publish.</p>}
          {data.testCallCompleted && <p>Test call completed ✓</p>}
        </SummaryCard>
      </div>
    </StepShell>
  );
}
